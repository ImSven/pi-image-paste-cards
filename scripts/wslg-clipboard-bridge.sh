#!/usr/bin/env bash
# wslg-clipboard-bridge.sh - make Windows screenshots pasteable inside WSLg.
#
# Why: when you copy an image in Windows (Win+Shift+S, Snipping Tool, ...),
# the WSLg clipboard bridge offers it on the Wayland clipboard only as
# image/bmp. Most terminal agents (pi, omp, claude code) only accept
# image/png | jpeg | gif | webp, and the PowerShell fallback is often blocked
# by ConstrainedLanguage mode, so image paste silently fails.
#
# What: watch the Wayland clipboard; when it offers BMP but no PNG, convert
# the BMP to PNG and offer that instead. Nothing else is touched.
#
# Requires: wl-clipboard (wl-paste, wl-copy) and ImageMagick (convert).
#   sudo apt install wl-clipboard imagemagick
set -u

for cmd in wl-paste wl-copy convert md5sum; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "wslg-clipboard-bridge: missing '$cmd'. Install: sudo apt install wl-clipboard imagemagick" >&2
        exit 1
    fi
done

# Only one instance per user runtime directory.
LOCK_DIR="${XDG_RUNTIME_DIR:-/tmp}/wslg-clipboard-bridge.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    # A lock older than a day is stale (e.g. after a crash): take it over.
    if [ -d "$LOCK_DIR" ] && [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +1440 2>/dev/null)" ]; then
        rmdir "$LOCK_DIR" 2>/dev/null || exit 0
        mkdir "$LOCK_DIR" 2>/dev/null || exit 0
    else
        exit 0
    fi
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT INT TERM

LAST_HASH=""

on_change() {
    local types hash
    types="$(timeout 2 wl-paste --list-types 2>/dev/null || true)"
    [ -n "$types" ] || return 0
    case "$types" in
        *image/bmp*) ;;
        *) LAST_HASH=""; return 0 ;;
    esac
    case "$types" in
        *image/png*) return 0 ;;   # Already PNG (possibly our own conversion).
    esac
    hash="$(timeout 5 wl-paste -t image/bmp 2>/dev/null | md5sum | cut -d' ' -f1)"
    [ -n "$hash" ] || return 0
    [ "$hash" != "$LAST_HASH" ] || return 0
    LAST_HASH="$hash"
    timeout 15 wl-paste -t image/bmp 2>/dev/null \
        | convert bmp:- png:- 2>/dev/null \
        | timeout 5 wl-copy --type image/png 2>/dev/null || true
}

# WSLg's compositor lacks the wlroots data-control protocol, so
# `wl-paste --watch` is unavailable; poll instead.
while true; do
    on_change
    sleep 0.5
done
