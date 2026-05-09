#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <errno.h>
#include <mach-o/dyld.h>
#include <notify.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

typedef int32_t PP_Module;
typedef int32_t PP_Resource;
typedef int32_t PP_Bool;
typedef double PP_Time;
typedef double PP_TimeTicks;
typedef const void *(*PPB_GetInterface)(const char *interface_name);

typedef struct PP_CompletionCallback {
  void (*func)(void *user_data, int32_t result);
  void *user_data;
  int32_t flags;
} PP_CompletionCallback;

typedef struct PPB_Core_1_0 {
  void (*AddRefResource)(PP_Resource resource);
  void (*ReleaseResource)(PP_Resource resource);
  PP_Time (*GetTime)(void);
  PP_TimeTicks (*GetTimeTicks)(void);
  void (*CallOnMainThread)(int32_t delay_in_milliseconds, PP_CompletionCallback callback, int32_t result);
  PP_Bool (*IsMainThread)(void);
} PPB_Core_1_0;

typedef int32_t (*PPP_InitializeModule_Fn)(PP_Module module, PPB_GetInterface get_browser);
typedef void (*PPP_ShutdownModule_Fn)(void);
typedef const void *(*PPP_GetInterface_Fn)(const char *interface_name);

static void *g_real = NULL;
static void *g_speed_interposer = NULL;
static PPP_InitializeModule_Fn g_real_init = NULL;
static PPP_ShutdownModule_Fn g_real_shutdown = NULL;
static PPP_GetInterface_Fn g_real_get_interface = NULL;
static PPB_GetInterface g_real_get_browser = NULL;
static const PPB_Core_1_0 *g_real_core = NULL;
static PPB_Core_1_0 g_core;

static char g_speed_file[1024];
static double g_speed = 1.0;
static time_t g_speed_mtime = 0;
static PP_Time g_time_real_anchor = 0;
static PP_Time g_time_virtual_anchor = 0;
static PP_TimeTicks g_ticks_real_anchor = 0;
static PP_TimeTicks g_ticks_virtual_anchor = 0;
static bool g_logged_speed_stat_error = false;
static bool g_logged_speed_open_error = false;
static bool g_notify_ready = false;
static int g_notify_token = NOTIFY_TOKEN_INVALID;

static double clamp_speed(double value) {
  if (!(value > 0.0)) return 1.0;
  if (value < 0.5) return 0.5;
  if (value > 10.0) return 10.0;
  return value;
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
    fprintf(stderr, "[xzspeed-shim] notify registration failed: %u\n", status);
    g_notify_token = NOTIFY_TOKEN_INVALID;
    return;
  }
  fprintf(stderr, "[xzspeed-shim] notify channel registered: %s\n", name);
}

static bool speed_from_notify(double *out) {
  setup_notify_channel();
  if (g_notify_token == NOTIFY_TOKEN_INVALID) return false;
  int changed = 0;
  notify_check(g_notify_token, &changed);
  if (!changed) return false;
  uint64_t state = 0;
  if (notify_get_state(g_notify_token, &state) != NOTIFY_STATUS_OK || state == 0) return false;
  *out = clamp_speed((double)state / 1000.0);
  return true;
}

static void apply_speed(double next) {
  next = clamp_speed(next);
  if (g_real_core && next != g_speed) {
    fprintf(stderr, "[xzspeed-shim] speed changed %0.2f -> %0.2f\n", g_speed, next);
    if (g_real_core->GetTime) {
      PP_Time now = g_real_core->GetTime();
      g_time_virtual_anchor = g_time_virtual_anchor + (now - g_time_real_anchor) * g_speed;
      g_time_real_anchor = now;
    }
    if (g_real_core->GetTimeTicks) {
      PP_TimeTicks now = g_real_core->GetTimeTicks();
      g_ticks_virtual_anchor = g_ticks_virtual_anchor + (now - g_ticks_real_anchor) * g_speed;
      g_ticks_real_anchor = now;
    }
  }
  g_speed = next;
}

static void refresh_speed(void) {
  double notify_speed = 1.0;
  if (speed_from_notify(&notify_speed)) {
    apply_speed(notify_speed);
    return;
  }

  if (!g_speed_file[0]) {
    const char *configured = getenv("XZFLASH_SPEED_FILE");
    if (configured && *configured) {
      snprintf(g_speed_file, sizeof(g_speed_file), "%s", configured);
    } else {
      snprintf(g_speed_file, sizeof(g_speed_file), "/tmp/xzflash-speed-%d", getuid());
    }
  }

  struct stat st;
  if (stat(g_speed_file, &st) != 0) {
    double next = 1.0;
    if (speed_from_env(&next)) {
      apply_speed(next);
      return;
    }
    if (!g_logged_speed_stat_error) {
      fprintf(stderr, "[xzspeed-shim] cannot stat speed file %s: %s\n", g_speed_file, strerror(errno));
      g_logged_speed_stat_error = true;
    }
    return;
  }
  if (st.st_mtime == g_speed_mtime) return;
  g_speed_mtime = st.st_mtime;

  FILE *f = fopen(g_speed_file, "r");
  if (!f) {
    double next = 1.0;
    if (speed_from_env(&next)) {
      apply_speed(next);
      return;
    }
    if (!g_logged_speed_open_error) {
      fprintf(stderr, "[xzspeed-shim] cannot open speed file %s: %s\n", g_speed_file, strerror(errno));
      g_logged_speed_open_error = true;
    }
    return;
  }
  double next = 1.0;
  int ok = fscanf(f, "%lf", &next);
  fclose(f);
  if (ok != 1) return;
  apply_speed(next);
}

static PP_Time shim_GetTime(void) {
  refresh_speed();
  if (!g_real_core || !g_real_core->GetTime) return CFAbsoluteTimeGetCurrent() + kCFAbsoluteTimeIntervalSince1970;
  PP_Time now = g_real_core->GetTime();
  return g_time_virtual_anchor + (now - g_time_real_anchor) * g_speed;
}

static PP_TimeTicks shim_GetTimeTicks(void) {
  refresh_speed();
  if (!g_real_core || !g_real_core->GetTimeTicks) return CFAbsoluteTimeGetCurrent();
  PP_TimeTicks now = g_real_core->GetTimeTicks();
  return g_ticks_virtual_anchor + (now - g_ticks_real_anchor) * g_speed;
}

static void shim_CallOnMainThread(int32_t delay, PP_CompletionCallback callback, int32_t result) {
  refresh_speed();
  if (!g_real_core || !g_real_core->CallOnMainThread) return;
  if (delay > 0 && g_speed != 1.0) {
    double scaled = (double)delay / g_speed;
    if (scaled < 1.0) scaled = 1.0;
    delay = (int32_t)scaled;
  }
  g_real_core->CallOnMainThread(delay, callback, result);
}

static const void *shim_get_browser(const char *interface_name) {
  const void *iface = g_real_get_browser ? g_real_get_browser(interface_name) : NULL;
  if (!iface || !interface_name) return iface;
  if (strcmp(interface_name, "PPB_Core;1.0") == 0) {
    g_real_core = (const PPB_Core_1_0 *)iface;
    g_core = *g_real_core;
    g_core.GetTime = shim_GetTime;
    g_core.GetTimeTicks = shim_GetTimeTicks;
    g_core.CallOnMainThread = shim_CallOnMainThread;
    if (g_real_core->GetTime) {
      g_time_real_anchor = g_real_core->GetTime();
      g_time_virtual_anchor = g_time_real_anchor;
    }
    if (g_real_core->GetTimeTicks) {
      g_ticks_real_anchor = g_real_core->GetTimeTicks();
      g_ticks_virtual_anchor = g_ticks_real_anchor;
    }
    refresh_speed();
    fprintf(stderr, "[xzspeed-shim] PPB_Core wrapped, speed=%0.2f\n", g_speed);
    return &g_core;
  }
  return iface;
}

static bool deep_speed_enabled(void) {
  const char *enabled = getenv("XZFLASH_DEEP_SPEED_HOOK");
  return enabled && strcmp(enabled, "1") == 0;
}

static void load_speed_interposer(void) {
  if (g_speed_interposer) return;
  if (!deep_speed_enabled()) return;
  char dir[4096];
  Dl_info info;
  if (!dladdr((void *)&load_speed_interposer, &info) || !info.dli_fname) return;
  snprintf(dir, sizeof(dir), "%s", info.dli_fname);
  char *slash = strrchr(dir, '/');
  if (!slash) return;
  strcpy(slash + 1, "libxzspeed.dylib");
  g_speed_interposer = dlopen(dir, RTLD_NOW | RTLD_GLOBAL);
  if (!g_speed_interposer) {
    fprintf(stderr, "[xzspeed-shim] speed interposer unavailable: %s\n", dlerror());
  } else {
    fprintf(stderr, "[xzspeed-shim] speed interposer loaded\n");
  }
}

static bool load_real_plugin(void) {
  if (g_real) return true;
  load_speed_interposer();

  Dl_info info;
  if (!dladdr((void *)&load_real_plugin, &info) || !info.dli_fname) return false;
  char path[4096];
  snprintf(path, sizeof(path), "%s", info.dli_fname);
  char *slash = strrchr(path, '/');
  if (!slash) return false;
  strcpy(slash + 1, "PepperFlashPlayer.real");

  g_real = dlopen(path, RTLD_LAZY | RTLD_LOCAL);
  if (!g_real) {
    fprintf(stderr, "[xzspeed-shim] failed to load real plugin: %s\n", dlerror());
    return false;
  }
  g_real_init = (PPP_InitializeModule_Fn)dlsym(g_real, "PPP_InitializeModule");
  g_real_shutdown = (PPP_ShutdownModule_Fn)dlsym(g_real, "PPP_ShutdownModule");
  g_real_get_interface = (PPP_GetInterface_Fn)dlsym(g_real, "PPP_GetInterface");
  if (!g_real_init || !g_real_get_interface) {
    fprintf(stderr, "[xzspeed-shim] real plugin missing PPAPI exports\n");
    return false;
  }
  return true;
}

__attribute__((visibility("default")))
int32_t PPP_InitializeModule(PP_Module module, PPB_GetInterface get_browser) {
  if (!load_real_plugin()) return -1;
  g_real_get_browser = get_browser;
  fprintf(stderr, "[xzspeed-shim] initializing real PepperFlashPlayer\n");
  return g_real_init(module, shim_get_browser);
}

__attribute__((visibility("default")))
void PPP_ShutdownModule(void) {
  if (g_real_shutdown) g_real_shutdown();
}

__attribute__((visibility("default")))
const void *PPP_GetInterface(const char *interface_name) {
  if (!load_real_plugin()) return NULL;
  return g_real_get_interface(interface_name);
}
