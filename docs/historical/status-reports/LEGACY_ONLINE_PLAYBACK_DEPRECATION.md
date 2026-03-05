# Legacy Online Playback System - REMOVED

**Date**: 2025-10-26 (Updated)
**Status**: ✅ **COMPLETELY REMOVED** in v3.0 (commits: bf4f82e, 1a21ca7, ec98e8b, 75e59b4)
**Replacement**: Phase E Unified EventQueue Playback (always-on since v2.0, only system in v3.0)

---

## Summary

The legacy online playback system has been **completely removed** as of v3.0. The unified EventQueue-based playback system is now the **only** implementation.

### What Was Removed (commit ec98e8b)

**C++ Methods (340 lines deleted)**:
- `processMidiPoints()` - Legacy MIDI processing (93 lines)
- `runMainApplication()` - Legacy online playback loop (123 lines)
- `playMidiRecord()` - Legacy MIDI playback (26 lines)
- `midiListener()` - Legacy MIDI listener (98 lines, was already commented)

**Python Methods (206 lines deleted in commits bf4f82e, 1a21ca7)**:
- Legacy code branches in `perform_midi_command()` (60 lines)
- Legacy code branches in `start_pianoid()` (45 lines)
- Legacy code branches in `start_realtime_playback()` (70 lines)
- Orphaned methods: `run_application()`, `test_run()`, `MIDI_listener()` (26 lines)
- Feature flag `USE_UNIFIED_PLAYBACK` and all checks (5 lines)

**Total cleanup**: **546 lines of legacy code removed**

### What Replaces It (v3.0+)

- **Unified EventQueue flow**: `start_realtime_playback()` → `OnlinePlaybackEngine` → `RealTimeEventBuffer` → `EventQueue`
- **Cycle-accurate scheduling**: Events scheduled by synthesis cycle (±5 cycles / ±6.67ms)
- **Thread-safe event insertion**: Concurrent events from REST API, MIDI, and other sources
- **No configuration needed**: Always enabled, no feature flags

---

## Migration Guide (v3.0+)

### No Migration Needed!

**v3.0+** uses unified playback automatically:
```python
# Just use the standard API - it's all unified now
pianoid.start_realtime_playback()  # ✓ Always uses EventQueue
pianoid.start_pianoid()             # ✓ Always uses EventQueue
```

**No environment variables needed** - the `PIANOID_UNIFIED_PLAYBACK` flag has been removed.

### Version History

**v2.0** (commits f73c7bf, 00b7717, 0871e1f, 5f54762):
- `PIANOID_UNIFIED_PLAYBACK` defaults to **`true`**
- Unified playback is the standard
- Legacy mode available via `PIANOID_UNIFIED_PLAYBACK=false` (deprecated)

**v3.0** (commits bf4f82e, 1a21ca7, ec98e8b):
- Legacy system **removed entirely** ✅
- Environment variable removed
- All code uses unified playback

---

## Deprecation Timeline

| Version | Status | Default | Action Required |
|---------|--------|---------|-----------------|
| **v1.x** | Legacy only | N/A | None |
| **v2.0** (current) | Legacy DEPRECATED | Unified (`true`) | Test with unified mode |
| **v2.x** | Deprecation warnings | Unified (`true`) | Migrate off legacy |
| **v3.0** (future) | Legacy REMOVED | Unified (only option) | Must use unified |

---

## Why Deprecate?

### Problems with Legacy System

1. **No cycle-accurate timing**: Events execute on wall-clock time, leading to jitter
2. **No event logging**: Impossible to debug or replay event sequences
3. **No event queue**: Cannot schedule future events or batch operations
4. **Thread safety issues**: Direct API calls bypass synchronization
5. **Offline/online inconsistency**: Two completely different code paths

### Benefits of Unified System

1. ✅ **Cycle-accurate timing**: ±5 cycles (±6.67ms) precision
2. ✅ **Event logging**: Full event history with timestamps
3. ✅ **EventQueue architecture**: Schedule, batch, and replay events
4. ✅ **Thread-safe**: Lock-free event insertion from multiple sources
5. ✅ **Consistent architecture**: Same code path for online and offline playback
6. ✅ **Drift correction**: Automatic calibration maintains accuracy
7. ✅ **Better debugging**: `RealTimeEventBuffer` statistics and monitoring

---

## Deprecation Warnings

When legacy mode is active (`PIANOID_UNIFIED_PLAYBACK=false`), you'll see:

```
Phase E Unified Playback: DISABLED (DEPRECATED)
DeprecationWarning: Legacy online playback is DEPRECATED and will be removed in v3.0.
Set PIANOID_UNIFIED_PLAYBACK=true to use the unified EventQueue system.
```

Additional warnings appear when legacy code paths execute:
- `start_pianoid()` legacy path
- `start_realtime_playback()` legacy path
- `perform_midi_command()` legacy MIDI processing

---

## Testing Your Migration

### 1. Enable Unified Playback

```bash
# Linux/Mac
export PIANOID_UNIFIED_PLAYBACK=true

# PowerShell
$env:PIANOID_UNIFIED_PLAYBACK = "true"

# CMD
set PIANOID_UNIFIED_PLAYBACK=true
```

### 2. Verify Unified Mode Active

Look for startup message:
```
Phase E Unified Playback: ENABLED
🚀 Routing to Phase E unified playback...
```

### 3. Test Your Workflow

- ✓ Start/stop playback
- ✓ Play notes via REST API
- ✓ Play notes via MIDI controller
- ✓ Sustain pedal functionality
- ✓ Parameter changes during playback

### 4. Check for Deprecation Warnings

If you see deprecation warnings, legacy code is still executing:
- Check environment variable is set correctly
- Restart the application
- Verify no code is explicitly disabling the flag

---

## What Gets Removed in v3.0

The following code will be **deleted**:

### C++ Side
- None (all C++ code is unified-only)

### Python Side (`pianoid.py`)
- Legacy branches in `start_pianoid()`
- Legacy branches in `start_realtime_playback()`
- Legacy branches in `perform_midi_command()`
- `processMidiPoints()` call paths from REST API
- Legacy MIDI listener implementation
- Feature flag checks (unified will be always-on)

### Estimated Cleanup
- ~300 lines of legacy code removal
- ~50 lines of feature flag removal
- Simplified architecture

---

## FAQ

### Q: Will my existing code break?

**A**: No. The unified system is 100% backward compatible. Just set the environment variable.

### Q: What if I find a bug in unified mode?

**A**: Report it immediately! File an issue and temporarily use `PIANOID_UNIFIED_PLAYBACK=false` as a workaround while we fix it.

### Q: Why not remove legacy code now?

**A**: We want to give users time to test and report issues. One version cycle (v2.x) provides a safe transition period.

### Q: Can I keep using legacy mode forever?

**A**: No. Legacy mode will be removed in v3.0. You must migrate before then.

### Q: What if unified mode has worse latency?

**A**: It doesn't. Unified mode achieves ±5 cycle accuracy, better than legacy wall-clock timing. Drift correction ensures long-term stability.

### Q: Will offline playback be affected?

**A**: No. Offline playback already uses EventQueue (since Phase 1-4). This deprecation only affects online/real-time playback.

---

## Support

If you encounter issues migrating to unified playback:

1. Check this document's migration guide
2. Review `PHASE_E_ONLINE_EVENTQUEUE_IMPLEMENTATION_PLAN.md`
3. Check `PLAYBACK_STATUS_SUMMARY.md` for current status
4. File an issue on GitHub with:
   - Environment variable settings
   - Console output (including deprecation warnings)
   - Steps to reproduce the problem
   - Expected vs actual behavior

---

## Conclusion

The unified EventQueue playback system represents a significant improvement in architecture, timing accuracy, and maintainability. We encourage all users to migrate immediately to benefit from:

- ✅ Cycle-accurate timing
- ✅ Event logging and debugging
- ✅ Thread-safe operations
- ✅ Consistent architecture

**Migration is simple**: Set `PIANOID_UNIFIED_PLAYBACK=true` and enjoy better playback!

---

**Document Version**: 1.0
**Last Updated**: 2025-10-25
**Related Commits**: f73c7bf, 00b7717
