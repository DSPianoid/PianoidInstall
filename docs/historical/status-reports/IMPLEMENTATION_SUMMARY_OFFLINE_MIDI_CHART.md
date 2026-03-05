# Implementation Summary: Offline MIDI Playback Chart

**Date**: 2025-10-19
**Status**: ✅ **COMPLETE**
**Task**: Create new chart route for testing offline MIDI playback

---

## What Was Implemented

### 1. Chart Function ([chartFunctions.py:574-701](pianoid_middleware/chartFunctions.py#L574-L701))

Created `offline_midi_playback_function()` with:

**Features**:
- Loads MIDI file from `MIDI_records/` directory
- Uses `MidiRecord.pack_for_offline_playback()` to convert MIDI to EventQueue
- Configures `PlaybackConfig` for offline rendering:
  - `audio_enabled = False` (no audio driver)
  - `record_to_buffer = True` (capture audio)
  - `cycle_accurate = True` (sample-accurate timing)
  - `max_duration_ms` from parameter
- Runs `pianoid.runOfflinePlayback()` with event queue
- Retrieves audio with `pianoid.getRecordedAudio()`
- Creates waveform chart (first 1 second displayed)
- Generates full audio using `create_audio_to_chart()`
- Returns comprehensive metrics

**Parameters**:
- `midi_file`: Name of MIDI file (choice: elise.mid, mond_1.mid)
- `max_seconds`: Maximum playback duration in seconds (float, default: 10.0)

**Returns**:
- `charts`: ChartArray with waveform data and audio
- `top_header`: "Offline MIDI Playback"
- `text_fields`: Dictionary with:
  - MIDI File name
  - Max Duration configured
  - Audio Duration actual
  - Samples Generated
  - Sample Rate
  - Cycles Processed
  - Events Processed
  - Render Time (wall-clock)
  - Render Speed (vs real-time)
  - Average Cycle Time

**Error Handling**:
- File not found errors
- Pianoid initialization errors
- Playback exceptions with stack traces
- No audio generated cases

**State Management**:
- Stops online playback if running
- Restarts after offline rendering
- Clean exception handling

---

### 2. Chart Configuration ([chart_config.json:332-355](pianoid_middleware/chart_config.json#L332-L355))

Added chart entry:
```json
{
  "name": "offline_midi_playback",
  "label": "Offline MIDI Playback",
  "function": "offline_midi_playback_function",
  "item_type": "chart",
  "parameters": [
    {
      "name": "midi_file",
      "type": "choice",
      "label": "MIDI File",
      "choices": ["elise.mid", "mond_1.mid"],
      "defaultValue": "elise.mid"
    },
    {
      "name": "max_seconds",
      "type": "float",
      "label": "Max Duration (seconds)",
      "defaultValue": 10.0
    }
  ]
}
```

---

### 3. Documentation

Created comprehensive documentation:

**[OFFLINE_MIDI_CHART_USAGE.md](OFFLINE_MIDI_CHART_USAGE.md)**:
- API endpoint documentation
- Parameter reference
- Usage examples (curl, Python, Frontend)
- Implementation details
- Workflow diagrams
- Performance notes
- Error handling guide
- Testing checklist
- Related documentation links

**[test_offline_midi_api.sh](test_offline_midi_api.sh)**:
- Bash script for testing the API
- Server availability check
- Formatted curl request
- JSON pretty-printing

---

## Integration with Playback Refactoring

This implementation is part of **Phase 4: Middleware Integration** from [PLAYBACK_REFACTORING_PLAN.md](PLAYBACK_REFACTORING_PLAN.md).

### Components Used

1. **MidiRecord.pack_for_offline_playback()** (Phase 4)
   - Converts MIDI file to EventQueue
   - Sample-accurate timing conversion

2. **pianoidCuda.PlaybackConfig** (Phase 2)
   - Configuration structure for playback engines

3. **pianoid.runOfflinePlayback()** (Phase 3)
   - C++ offline playback engine
   - Cycle-accurate rendering

4. **pianoid.getRecordedAudio()** (Phase 3)
   - Retrieves audio buffer after rendering

5. **ChartArray.create_audio_to_chart()** (Chart API)
   - Sonification functionality
   - Base64 WAV encoding

---

## Testing Status

### ✅ Completed

- [x] Chart function implemented
- [x] Chart configuration added
- [x] Configuration file validated (JSON parsing successful)
- [x] MIDI files verified (elise.mid, mond_1.mid present)
- [x] Documentation created

### ⏳ Pending (Requires Backend Server)

- [ ] Backend server running
- [ ] Chart visible in `/graph_names` endpoint
- [ ] Successful render with curl
- [ ] Waveform displays correctly
- [ ] Audio playback works
- [ ] Performance metrics accurate
- [ ] Error handling validated

---

## Files Modified/Created

### Modified Files

1. **[pianoid_middleware/chartFunctions.py](pianoid_middleware/chartFunctions.py)**
   - Added `offline_midi_playback_function()` (127 lines)
   - Location: Lines 574-701

2. **[pianoid_middleware/chart_config.json](pianoid_middleware/chart_config.json)**
   - Added chart entry with 2 parameters
   - Location: Lines 332-355

### Created Files

1. **[OFFLINE_MIDI_CHART_USAGE.md](OFFLINE_MIDI_CHART_USAGE.md)**
   - Complete usage guide (450+ lines)

2. **[test_offline_midi_api.sh](test_offline_midi_api.sh)**
   - API test script (35 lines)

3. **[IMPLEMENTATION_SUMMARY_OFFLINE_MIDI_CHART.md](IMPLEMENTATION_SUMMARY_OFFLINE_MIDI_CHART.md)**
   - This file

---

## Usage

### 1. Start Backend Server

```bash
cd pianoid_middleware
python backendServer.py
```

### 2. Test via curl

```bash
# Default test (elise.mid, 10 seconds)
curl -X POST http://localhost:5000/get_chart_test \
  -H "Content-Type: application/json" \
  -d '{
    "chartType": "offline_midi_playback",
    "midi_file": "elise.mid",
    "max_seconds": 10.0
  }'

# Or use the test script
bash test_offline_midi_api.sh elise.mid 10.0
```

### 3. Test via Frontend UI

1. Open Pianoid web interface
2. Navigate to Charts section
3. Select "Offline MIDI Playback"
4. Choose MIDI file and duration
5. Click "Generate Chart"

---

## API Request/Response

### Request

```json
{
  "chartType": "offline_midi_playback",
  "midi_file": "elise.mid",
  "max_seconds": 10.0
}
```

### Response

```json
{
  "data": [[0.1, 0.2, 0.15, ...]],
  "general_header": "Offline MIDI Playback",
  "text_fields": {
    "MIDI File": "elise.mid",
    "Max Duration": "10.0 s",
    "Audio Duration": "8.45 s",
    "Samples Generated": "405,600",
    "Sample Rate": "48000 Hz",
    "Cycles Processed": "6,337",
    "Events Processed": "142",
    "Render Time": "12.34 s",
    "Render Speed": "0.68x real-time",
    "Average Cycle Time": "1.95 ms"
  },
  "chart_headers": ["Waveform"],
  "audio_data": ["base64_encoded_wav_data"]
}
```

---

## Technical Notes

### Offline Playback Flow

```
1. Load MIDI file → MidiRecord
2. Parse events → pack_for_offline_playback()
3. Create EventQueue (cycle-accurate timestamps)
4. Configure PlaybackConfig
5. Stop online playback (if running)
6. Run OfflinePlaybackEngine
   - Process events at exact cycle indices
   - No audio driver (faster than real-time possible)
   - Record all output to buffer
7. Retrieve audio buffer
8. Generate waveform chart
9. Create base64 WAV for playback
10. Restart online playback (if was running)
11. Return chart with metrics
```

### Performance Characteristics

**Current (Phase 5)**:
- Render speed: ~0.5-0.7x real-time
- Average cycle time: ~1.8-2.0 ms
- Memory: Pre-allocates full audio buffer

**Target (Phase 6)**:
- Render speed: 5-20x real-time
- Optimized GPU kernels
- Streaming buffer support

---

## Validation

### Configuration Validated

```bash
$ cd pianoid_middleware
$ python -c "import json; charts = json.load(open('chart_config.json')); \
  print([c for c in charts if c['name'] == 'offline_midi_playback'][0])"

{
  'name': 'offline_midi_playback',
  'label': 'Offline MIDI Playback',
  'function': 'offline_midi_playback_function',
  'item_type': 'chart',
  'parameters': [...]
}
```

### MIDI Files Validated

```bash
$ ls -lh pianoid_middleware/MIDI_records/*.mid
-rw-r--r-- 1 astri 197609 14K elise.mid
-rw-r--r-- 1 astri 197609 16K mond_1.mid
```

---

## Next Steps

1. **Start backend server** and verify chart registration:
   ```bash
   curl http://localhost:5000/graph_names | grep offline_midi
   ```

2. **Run test** with curl or test script

3. **Verify output**:
   - Waveform displays correctly
   - Audio plays in browser
   - Metrics are accurate

4. **Update status documents**:
   - [PLAYBACK_STATUS_SUMMARY.md](PLAYBACK_STATUS_SUMMARY.md)
   - Add test results

5. **Consider optimizations** (Phase 6):
   - Profile render performance
   - Optimize buffer allocation
   - Enable streaming output

---

## Conclusion

The Offline MIDI Playback chart is **fully implemented** and ready for testing. It provides a complete testing interface for the offline playback refactoring work through the existing Chart API infrastructure.

**Key Achievements**:
- ✅ Uses `create_audio_to_chart()` as requested
- ✅ Integrates with CHART_API_DOCUMENTATION.md patterns
- ✅ Two parameters: MIDI file name, max duration
- ✅ Returns waveform chart with audio playback
- ✅ Comprehensive error handling
- ✅ Performance metrics included
- ✅ Well-documented

**Status**: Ready for testing once backend server is running.
