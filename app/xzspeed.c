#include <CoreFoundation/CoreFoundation.h>
#include <dispatch/dispatch.h>
#include <dlfcn.h>
#include <errno.h>
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <mach-o/nlist.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <notify.h>
#include <poll.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/select.h>
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
static bool g_logged_speed_stat_error = false;
static bool g_logged_speed_open_error = false;
static bool g_notify_ready = false;
static int g_notify_token = NOTIFY_TOKEN_INVALID;

static void rebase_locked(void);

static double clamp_speed(double s) {
  if (!(s > 0.0)) return 1.0;
  if (s < 0.5) return 0.5;
  if (s > 10.0) return 10.0;
  return s;
}

static bool speed_from_env(double *out) {
  const char *value = getenv("XZFLASH_SPEED_FACTOR");
  if (!value || !*value) return false;
  char *end = NULL;
  double parsed = strtod(value, &end);
  if (end == value) return false;
  *out = clamp_speed(parsed);
  return true;
}

static void setup_notify_channel(void) {
  if (g_notify_ready) return;
  g_notify_ready = true;
  const char *name = getenv("XZFLASH_SPEED_NOTIFY_NAME");
  if (!name || !*name) return;
  uint32_t status = notify_register_check(name, &g_notify_token);
  if (status != NOTIFY_STATUS_OK) {
    fprintf(stderr, "[xzspeed] notify registration failed: %u\n", status);
    g_notify_token = NOTIFY_TOKEN_INVALID;
    return;
  }
  fprintf(stderr, "[xzspeed] notify channel registered: %s\n", name);
}

static bool speed_from_notify(double *out) {
  setup_notify_channel();
  if (g_notify_token == NOTIFY_TOKEN_INVALID) return false;
  int changed = 0;
  notify_check(g_notify_token, &changed);
  uint64_t state = 0;
  if (notify_get_state(g_notify_token, &state) != NOTIFY_STATUS_OK || state == 0) return false;
  *out = clamp_speed((double)state / 1000.0);
  return true;
}

static void apply_speed_locked(double next) {
  next = clamp_speed(next);
  if (next != g_speed) {
    fprintf(stderr, "[xzspeed] speed changed %0.2f -> %0.2f\n", g_speed, next);
    rebase_locked();
    g_speed = next;
  }
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

  double notify_speed = 1.0;
  if (speed_from_notify(&notify_speed)) {
    apply_speed_locked(notify_speed);
    return;
  }

  struct stat st;
  if (stat(g_speed_file, &st) != 0) {
    double env_speed = 1.0;
    if (speed_from_env(&env_speed)) {
      apply_speed_locked(env_speed);
      return;
    }
    if (!g_logged_speed_stat_error) {
      fprintf(stderr, "[xzspeed] cannot stat speed file %s: %s\n", g_speed_file, strerror(errno));
      g_logged_speed_stat_error = true;
    }
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
  if (!f) {
    double env_speed = 1.0;
    if (speed_from_env(&env_speed)) {
      apply_speed_locked(env_speed);
      return;
    }
    if (!g_logged_speed_open_error) {
      fprintf(stderr, "[xzspeed] cannot open speed file %s: %s\n", g_speed_file, strerror(errno));
      g_logged_speed_open_error = true;
    }
    return;
  }
  double next = 1.0;
  int ok = fscanf(f, "%lf", &next);
  fclose(f);
  if (ok != 1) return;
  apply_speed_locked(next);
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

  const char *configured = getenv("XZFLASH_SPEED_FILE");
  if (configured && *configured) {
    snprintf(g_speed_file, sizeof(g_speed_file), "%s", configured);
  } else {
    snprintf(g_speed_file, sizeof(g_speed_file), "/tmp/xzflash-speed-%d", getuid());
  }

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

static int my_poll(struct pollfd *fds, nfds_t nfds, int timeout) {
  if (!g_active || timeout <= 0) return poll(fds, nfds, timeout);
  double scaled = (double)timeout / current_speed();
  if (scaled < 1.0) scaled = 1.0;
  return poll(fds, nfds, (int)scaled);
}

static int my_select(int nfds, fd_set *readfds, fd_set *writefds, fd_set *exceptfds, struct timeval *timeout) {
  if (!g_active || !timeout) return select(nfds, readfds, writefds, exceptfds, timeout);
  double seconds = (double)timeout->tv_sec + (double)timeout->tv_usec / 1000000.0;
  struct timeval scaled = sec_to_tv(seconds / current_speed());
  return select(nfds, readfds, writefds, exceptfds, &scaled);
}

static int my_pthread_cond_timedwait(pthread_cond_t *cond, pthread_mutex_t *mutex, const struct timespec *abstime) {
  if (!g_active || !abstime) return pthread_cond_timedwait(cond, mutex, abstime);
  double speed = current_speed();
  if (speed == 1.0) return pthread_cond_timedwait(cond, mutex, abstime);
  struct timespec now;
  clock_gettime(CLOCK_REALTIME, &now);
  double delay = ts_to_sec(*abstime) - ts_to_sec(now);
  if (delay <= 0) return pthread_cond_timedwait(cond, mutex, abstime);
  struct timespec scaled = sec_to_ts(ts_to_sec(now) + delay / speed);
  return pthread_cond_timedwait(cond, mutex, &scaled);
}

typedef struct SymbolRebinding {
  const char *name;
  void *replacement;
} SymbolRebinding;

static const SymbolRebinding kRebindings[] = {
  { "mach_absolute_time", (void *)my_mach_absolute_time },
  { "clock_gettime", (void *)my_clock_gettime },
  { "gettimeofday", (void *)my_gettimeofday },
  { "time", (void *)my_time },
  { "CFAbsoluteTimeGetCurrent", (void *)my_CFAbsoluteTimeGetCurrent },
  { "dispatch_time", (void *)my_dispatch_time },
  { "dispatch_source_set_timer", (void *)my_dispatch_source_set_timer },
  { "pthread_cond_timedwait_relative_np", (void *)my_pthread_cond_timedwait_relative_np },
  { "pthread_cond_timedwait", (void *)my_pthread_cond_timedwait },
  { "nanosleep", (void *)my_nanosleep },
  { "usleep", (void *)my_usleep },
  { "poll", (void *)my_poll },
  { "select", (void *)my_select },
  { "select$1050", (void *)my_select },
};

static void *replacement_for_symbol(const char *symbol) {
  if (!symbol || symbol[0] != '_') return NULL;
  const char *name = symbol + 1;
  for (size_t i = 0; i < sizeof(kRebindings) / sizeof(kRebindings[0]); i++) {
    if (strcmp(name, kRebindings[i].name) == 0) return kRebindings[i].replacement;
  }
  return NULL;
}

static void write_pointer(void **slot, void *replacement) {
  if (!slot || !replacement || *slot == replacement) return;
  vm_address_t page = (vm_address_t)slot & ~(vm_address_t)(getpagesize() - 1);
  vm_protect(mach_task_self(), page, (vm_size_t)getpagesize(), false,
             VM_PROT_READ | VM_PROT_WRITE | VM_PROT_COPY);
  *slot = replacement;
}

static int rebind_section(const struct section_64 *section, intptr_t slide,
                          const struct symtab_command *symtab_cmd,
                          const struct dysymtab_command *dysymtab_cmd,
                          uintptr_t linkedit_base) {
  if (!section || !symtab_cmd || !dysymtab_cmd || !linkedit_base) return 0;
  uint32_t type = section->flags & SECTION_TYPE;
  if (type != S_LAZY_SYMBOL_POINTERS && type != S_NON_LAZY_SYMBOL_POINTERS) return 0;

  struct nlist_64 *symtab = (struct nlist_64 *)(linkedit_base + symtab_cmd->symoff);
  char *strtab = (char *)(linkedit_base + symtab_cmd->stroff);
  uint32_t *indirect = (uint32_t *)(linkedit_base + dysymtab_cmd->indirectsymoff);
  void **bindings = (void **)((uintptr_t)slide + section->addr);
  uint64_t count = section->size / sizeof(void *);
  int rebound = 0;

  for (uint64_t i = 0; i < count; i++) {
    uint32_t symbol_index = indirect[section->reserved1 + i];
    if (symbol_index == INDIRECT_SYMBOL_ABS || symbol_index == INDIRECT_SYMBOL_LOCAL ||
        symbol_index == (INDIRECT_SYMBOL_LOCAL | INDIRECT_SYMBOL_ABS)) {
      continue;
    }
    const char *symbol = strtab + symtab[symbol_index].n_un.n_strx;
    void *replacement = replacement_for_symbol(symbol);
    if (replacement) {
      write_pointer(&bindings[i], replacement);
      rebound++;
    }
  }
  return rebound;
}

static int rebind_image(const struct mach_header_64 *header, intptr_t slide) {
  if (!header || header->magic != MH_MAGIC_64) return 0;

  const struct symtab_command *symtab_cmd = NULL;
  const struct dysymtab_command *dysymtab_cmd = NULL;
  const struct segment_command_64 *linkedit = NULL;
  const struct load_command *cmd = (const struct load_command *)(header + 1);

  for (uint32_t i = 0; i < header->ncmds; i++) {
    if (cmd->cmd == LC_SYMTAB) symtab_cmd = (const struct symtab_command *)cmd;
    else if (cmd->cmd == LC_DYSYMTAB) dysymtab_cmd = (const struct dysymtab_command *)cmd;
    else if (cmd->cmd == LC_SEGMENT_64) {
      const struct segment_command_64 *seg = (const struct segment_command_64 *)cmd;
      if (strcmp(seg->segname, SEG_LINKEDIT) == 0) linkedit = seg;
    }
    cmd = (const struct load_command *)((const char *)cmd + cmd->cmdsize);
  }

  if (!symtab_cmd || !dysymtab_cmd || !linkedit) return 0;
  uintptr_t linkedit_base = (uintptr_t)slide + linkedit->vmaddr - linkedit->fileoff;
  int rebound = 0;
  cmd = (const struct load_command *)(header + 1);
  for (uint32_t i = 0; i < header->ncmds; i++) {
    if (cmd->cmd == LC_SEGMENT_64) {
      const struct segment_command_64 *seg = (const struct segment_command_64 *)cmd;
      const struct section_64 *section = (const struct section_64 *)(seg + 1);
      for (uint32_t j = 0; j < seg->nsects; j++) {
        rebound += rebind_section(&section[j], slide, symtab_cmd, dysymtab_cmd, linkedit_base);
      }
    }
    cmd = (const struct load_command *)((const char *)cmd + cmd->cmdsize);
  }
  return rebound;
}

__attribute__((visibility("default")))
void xzspeed_rebind_image_named(const char *name_part) {
  if (!name_part || !*name_part) name_part = "PepperFlashPlayer.real";
  int total = 0;
  uint32_t count = _dyld_image_count();
  for (uint32_t i = 0; i < count; i++) {
    const char *name = _dyld_get_image_name(i);
    if (!name || !strstr(name, name_part)) continue;
    const struct mach_header *header = _dyld_get_image_header(i);
    total += rebind_image((const struct mach_header_64 *)header, _dyld_get_image_vmaddr_slide(i));
    fprintf(stderr, "[xzspeed] rebound %d timer symbols in %s\n", total, name);
    return;
  }
  fprintf(stderr, "[xzspeed] target image not found for rebind: %s\n", name_part);
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
  { (const void *)my_pthread_cond_timedwait, (const void *)pthread_cond_timedwait },
  { (const void *)my_nanosleep, (const void *)nanosleep },
  { (const void *)my_usleep, (const void *)usleep },
  { (const void *)my_poll, (const void *)poll },
  { (const void *)my_select, (const void *)select },
};
