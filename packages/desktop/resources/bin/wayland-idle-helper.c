/*
 * wayland-idle-helper: Reports system idle/resumed events via stdout
 * using the Wayland ext_idle_notifier_v1 protocol.
 *
 * Used by Electron's main process for reliable idle detection on Wayland
 * compositors (KDE, GNOME, Hyprland, Sway, etc.).
 *
 * Usage: wayland-idle-helper [timeout_ms]
 *   timeout_ms: idle threshold in milliseconds (default 10000)
 *
 * Output (line-buffered):
 *   IDLE     — compositor reports user is idle
 *   RESUMED  — compositor reports user activity resumed
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>
#include "ext-idle-notify-v1-client-protocol.h"

static struct wl_seat *seat = NULL;
static struct ext_idle_notifier_v1 *notifier = NULL;

static void on_idled(void *data, struct ext_idle_notification_v1 *notif)
{
    (void)data; (void)notif;
    printf("IDLE\n");
    fflush(stdout);
}

static void on_resumed(void *data, struct ext_idle_notification_v1 *notif)
{
    (void)data; (void)notif;
    printf("RESUMED\n");
    fflush(stdout);
}

static const struct ext_idle_notification_v1_listener notif_listener = {
    .idled = on_idled,
    .resumed = on_resumed,
};

static void registry_global(void *data, struct wl_registry *registry,
                            uint32_t name, const char *interface,
                            uint32_t version)
{
    (void)data; (void)version;
    if (strcmp(interface, "wl_seat") == 0 && !seat) {
        seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
    } else if (strcmp(interface, "ext_idle_notifier_v1") == 0) {
        notifier = wl_registry_bind(registry, name,
                                    &ext_idle_notifier_v1_interface, 1);
    }
}

static void registry_global_remove(void *data, struct wl_registry *registry,
                                   uint32_t name)
{
    (void)data; (void)registry; (void)name;
}

static const struct wl_registry_listener registry_listener = {
    .global = registry_global,
    .global_remove = registry_global_remove,
};

int main(int argc, char *argv[])
{
    uint32_t timeout_ms = 10000;
    if (argc > 1) {
        long val = atol(argv[1]);
        if (val > 0) timeout_ms = (uint32_t)val;
    }

    struct wl_display *display = wl_display_connect(NULL);
    if (!display) {
        fprintf(stderr, "ERROR: Cannot connect to Wayland display\n");
        return 1;
    }

    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    wl_display_roundtrip(display);

    if (!seat) {
        fprintf(stderr, "ERROR: No wl_seat found\n");
        wl_display_disconnect(display);
        return 1;
    }
    if (!notifier) {
        fprintf(stderr, "ERROR: ext_idle_notifier_v1 not supported\n");
        wl_display_disconnect(display);
        return 1;
    }

    struct ext_idle_notification_v1 *notif =
        ext_idle_notifier_v1_get_idle_notification(notifier, timeout_ms, seat);
    ext_idle_notification_v1_add_listener(notif, &notif_listener, NULL);

    /* Signal readiness — Electron waits for this */
    printf("READY\n");
    fflush(stdout);

    while (wl_display_dispatch(display) != -1) {
        /* blocks until events arrive */
    }

    ext_idle_notification_v1_destroy(notif);
    ext_idle_notifier_v1_destroy(notifier);
    wl_display_disconnect(display);
    return 0;
}
