#include <CoreFoundation/CoreFoundation.h>
#include <dispatch/dispatch.h>
#include <dlfcn.h>
#include <errno.h>
#include <mach/mach_time.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>
#include <crt_externs.h>

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static bool g_active = false;
static char g_speed_file[1024];
static double g_speed = 1.0;
static double g_last_check_ms = 0.0;
static struct stat g_speed_stat;

static uint64_t g_mach_real_anchor = 0;
static uint64_t g_mach_virt_anchor = 0;
static struct timespec g_rt_real_anchor = {0, 0};
static struct timespec g_rt_virt_anchor = {0, 0};
static struct timespec g_mono_real_anchor = {0, 0};
static struct timespec g_mono_virt_anchor = {0, 0};
static struct timeval g_gtod_real_anchor = {0, 0};
static struct timeval g_gtod_virt_anchor = {0, 0};
static time_t g_time_real_anchor = 0;
static time_t g_time_virt_anchor = 0;
static CFAbsoluteTime g_cf_real_anchor = 0;
static CFAbsoluteTime g_cf_virt_anchor = 0;

static double clamp_speed(double s) {
  if (!(s > 0.0)) return 1.0;
  if (s < 0.5) return 0.5;
  if (s > 10.0) return 10.0;
  return s;
}

static double ts_to_sec(struct timespec t) {
  return (double)t.tv_sec + (double)t.tv_nsec / 1000000000.0;
}

static struct timespec sec_to_ts(double s) {
  struct timespec out;
  if (s < 0) s = 0;
  out.tv_sec = (time_t)s;
  out.tv_nsec = (long)((s - (double)out.tv_sec) * 1000000000.0);
  if (out.tv_nsec < 0) out.tv_nsec = 0;
  if (out.tv_nsec > 999999999L) out.tv_nsec = 999999999L;
  return out;
}

static struct timeval sec_to_tv(double s) {
  struct timeval out;
  if (s < 0) s = 0;
  out.tv_sec = (time_t)s;
  out.tv_usec = (suseconds_t)((s - (double)out.tv_sec) * 1000000.0);
  if (out.tv_usec < 0) out.tv_usec = 0;
  if (out.tv_usec > 999999L) out.tv_usec = 999999L;
  return out;
}

static double now_mono_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return ts_to_sec(t) * 1000.0;
}

static struct timespec virtual_ts(struct timespec real_anchor, struct timespec virt_anchor, clockid_t clk) {
  struct timespec now;
  clock_gettime(clk, &now);
  double elapsed = ts_to_sec(now) - ts_to_sec(real_anchor);
  return sec_to_ts(ts_to_sec(virt_anchor) + elapsed * g_speed);
}

static struct timeval virtual_tv(void) {
  struct timeval now;
  gettimeofday(&now, NULL);
  double real = (double)now.tv_sec + (double)now.tv_usec / 1000000.0;
  double anchor = (double)g_gtod_real_anchor.tv_sec + (double)g_gtod_real_anchor.tv_usec / 1000000.0;
  double virt = (double)g_gtod_virt_anchor.tv_sec + (double)g_gtod_virt_anchor.tv_usec / 1000000.0;
  return sec_to_tv(virt + (real - anchor) * g_speed);
}

static time_t virtual_time_value(void) {
  time_t now = time(NULL);
  return g_time_virt_anchor + (time_t)((double)(now - g_time_real_anchor) * g_speed);
}

static uint64_t virtual_mach_value(void) {
  uint64_t now = mach_absolute_time();
  double elapsed = (double)(now - g_mach_real_anchor);
  return g_mach_virt_anchor + (uint64_t)(elapsed * g_speed);
}

static CFAbsoluteTime virtual_cf_value(void) {
  CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
  return g_cf_virt_anchor + (now - g_cf_real_anchor) * g_speed;
}

static void rebase_locked(void) {
  g_mach_virt_anchor = virtual_mach_value();
  g_mach_real_anchor = mach_absolute_time();
  g_rt_virt_anchor = virtual_ts(g_rt_real_anchor, g_rt_virt_anchor, CLOCK_REALTIME);
  clock_gettime(CLOCK_REALTIME, &g_rt_real_anchor);
  g_mono_virt_anchor = virtual_ts(g_mono_real_anchor, g_mono_virt_anchor, CLOCK_MONOTONIC);
  clock_gettime(CLOCK_MONOTONIC, &g_mono_real_anchor);
  g_gtod_virt_anchor = virtual_tv();
  gettimeofday(&g_gtod_real_anchor, NULL);
  g_time_virt_anchor = virtual_time_value();
  g_time_real_anchor = time(NULL);
  g_cf_virt_anchor = virtual_cf_value();
  g_cf_real_anchor = CFAbsoluteTimeGetCurrent();
}

static void maybe_refresh_speed_locked(void) {
  double now = now_mono_ms();
  if (now - g_last_check_ms < 200.0) return;
  g_last_check_ms = now;

  struct stat st;
  if (stat(g_speed_file, &st) != 0) {
    if (g_speed != 1.0) {
      rebase_locked();
      g_speed = 1.0;
    }
    memset(&g_speed_stat, 0, sizeof(g_speed_stat));
    return;
  }
  if (st.st_mtimespec.tv_sec == g_speed_stat.st_mtimespec.tv_sec &&
      st.st_mtimespec.tv_nsec == g_speed_stat.st_mtimespec.tv_nsec) {
    return;
  }
  g_speed_stat = st;
  FILE *f = fopen(g_speed_file, "r");
  if (!f) return;
  double next = 1.0;
  int ok = fscanf(f, "%lf", &next);
  fclose(f);
  if (ok != 1) return;
  next = clamp_speed(next);
  if (next != g_speed) {
    rebase_locked();
    g_speed = next;
  }
}

static double current_speed(void) {
  double out;
  pthread_mutex_lock(&g_lock);
  maybe_refresh_speed_locked();
  out = g_speed;
  pthread_mutex_unlock(&g_lock);
  return out;
}

static uint64_t scale_u64_interval(uint64_t value, double speed) {
  if (value == 0 || value == UINT64_MAX || speed == 1.0) return value;
  double scaled = (double)value / speed;
  if (scaled < 1.0) return 1;
  if (scaled > (double)UINT64_MAX) return UINT64_MAX;
  return (uint64_t)scaled;
}

static int64_t scale_i64_interval(int64_t value, double speed) {
  if (value <= 0 || speed == 1.0) return value;
  double scaled = (double)value / speed;
  if (scaled < 1.0) return 1;
  if (scaled > (double)INT64_MAX) return INT64_MAX;
  return (int64_t)scaled;
}

__attribute__((constructor))
static void xzspeed_init(void) {
  char ***argvp = _NSGetArgv();
  int *argcp = _NSGetArgc();
  if (!argvp || !argcp || !*argvp) return;

  bool is_ppapi = false;
  bool is_broker = false;
  for (int i = 0; i < *argcp; i++) {
    const char *a = (*argvp)[i];
    if (!a) continue;
    if (strstr(a, "--type=ppapi")) is_ppapi = true;
    if (strstr(a, "ppapi-broker")) is_broker = true;
  }
  if (!is_ppapi || is_broker) return;
  g_active = true;

  const char *home = getenv("HOME");
  if (!home || !*home) home = "/tmp";
  snprintf(g_speed_file, sizeof(g_speed_file), "%s/.xzflash-speed", home);

  g_mach_real_anchor = mach_absolute_time();
  g_mach_virt_anchor = g_mach_real_anchor;
  clock_gettime(CLOCK_REALTIME, &g_rt_real_anchor);
  g_rt_virt_anchor = g_rt_real_anchor;
  clock_gettime(CLOCK_MONOTONIC, &g_mono_real_anchor);
  g_mono_virt_anchor = g_mono_real_anchor;
  gettimeofday(&g_gtod_real_anchor, NULL);
  g_gtod_virt_anchor = g_gtod_real_anchor;
  g_time_real_anchor = time(NULL);
  g_time_virt_anchor = g_time_real_anchor;
  g_cf_real_anchor = CFAbsoluteTimeGetCurrent();
  g_cf_virt_anchor = g_cf_real_anchor;

  pthread_mutex_lock(&g_lock);
  maybe_refresh_speed_locked();
  pthread_mutex_unlock(&g_lock);
  fprintf(stderr, "[xzspeed] active in pid %d, speed file %s\n", getpid(), g_speed_file);
}

static uint64_t my_mach_absolute_time(void) {
  if (!g_active) return mach_absolute_time();
  uint64_t out;
  pthread_mutex_lock(&g_lock);
  maybe_refresh_speed_locked();
  out = virtual_mach_value();
  pthread_mutex_unlock(&g_lock);
  return out;
}

static int my_clock_gettime(clockid_t clk, struct timespec *tp) {
  if (!g_active || !tp) return clock_gettime(clk, tp);
  if (clk != CLOCK_REALTIME && clk != CLOCK_MONOTONIC) return clock_gettime(clk, tp);
  pthread_mutex_lock(&g_lock);
  maybe_refresh_speed_locked();
  *tp = (clk == CLOCK_REALTIME)
      ? virtual_ts(g_rt_real_anchor, g_rt_virt_anchor, CLOCK_REALTIME)
      : virtual_ts(g_mono_real_anchor, g_mono_virt_anchor, CLOCK_MONOTONIC);
  pthread_mutex_unlock(&g_lock);
  return 0;
}

static int my_gettimeofday(struct timeval *tv, void *tz) {
  if (!g_active || !tv) return gettimeofday(tv, tz);
  pthread_mutex_lock(&g_lock);
  maybe_refresh_speed_locked();
  *tv = virtual_tv();
  pthread_mutex_unlock(&g_lock);
  return 0;
}

static time_t my_time(time_t *tloc) {
  if (!g_active) return time(tloc);
  pthread_mutex_lock(&g_lock);
  maybe_refresh_speed_locked();
  time_t out = virtual_time_value();
  pthread_mutex_unlock(&g_lock);
  if (tloc) *tloc = out;
  return out;
}

static CFAbsoluteTime my_CFAbsoluteTimeGetCurrent(void) {
  if (!g_active) return CFAbsoluteTimeGetCurrent();
  pthread_mutex_lock(&g_lock);
  maybe_refresh_speed_locked();
  CFAbsoluteTime out = virtual_cf_value();
  pthread_mutex_unlock(&g_lock);
  return out;
}

static dispatch_time_t my_dispatch_time(dispatch_time_t when, int64_t delta) {
  if (!g_active || delta <= 0) return dispatch_time(when, delta);
  return dispatch_time(when, scale_i64_interval(delta, current_speed()));
}

static void my_dispatch_source_set_timer(dispatch_source_t source, dispatch_time_t start, uint64_t interval, uint64_t leeway) {
  if (!g_active) {
    dispatch_source_set_timer(source, start, interval, leeway);
    return;
  }
  double speed = current_speed();
  dispatch_source_set_timer(source, start, scale_u64_interval(interval, speed), scale_u64_interval(leeway, speed));
}

static int my_pthread_cond_timedwait_relative_np(pthread_cond_t *cond, pthread_mutex_t *mutex, const struct timespec *relative) {
  if (!g_active || !relative) return pthread_cond_timedwait_relative_np(cond, mutex, relative);
  double speed = current_speed();
  struct timespec scaled = sec_to_ts(ts_to_sec(*relative) / speed);
  return pthread_cond_timedwait_relative_np(cond, mutex, &scaled);
}

static int my_nanosleep(const struct timespec *rqtp, struct timespec *rmtp) {
  if (!g_active || !rqtp) return nanosleep(rqtp, rmtp);
  struct timespec scaled = sec_to_ts(ts_to_sec(*rqtp) / current_speed());
  return nanosleep(&scaled, rmtp);
}

static int my_usleep(useconds_t usec) {
  if (!g_active) return usleep(usec);
  double scaled = (double)usec / current_speed();
  if (scaled < 1.0) scaled = 1.0;
  return usleep((useconds_t)scaled);
}

__attribute__((used)) static struct {
  const void *replacement;
  const void *replacee;
} interposers[] __attribute__((section("__DATA,__interpose"))) = {
  { (const void *)my_mach_absolute_time, (const void *)mach_absolute_time },
  { (const void *)my_clock_gettime, (const void *)clock_gettime },
  { (const void *)my_gettimeofday, (const void *)gettimeofday },
  { (const void *)my_time, (const void *)time },
  { (const void *)my_CFAbsoluteTimeGetCurrent, (const void *)CFAbsoluteTimeGetCurrent },
  { (const void *)my_dispatch_time, (const void *)dispatch_time },
  { (const void *)my_dispatch_source_set_timer, (const void *)dispatch_source_set_timer },
  { (const void *)my_pthread_cond_timedwait_relative_np, (const void *)pthread_cond_timedwait_relative_np },
  { (const void *)my_nanosleep, (const void *)nanosleep },
  { (const void *)my_usleep, (const void *)usleep },
};
