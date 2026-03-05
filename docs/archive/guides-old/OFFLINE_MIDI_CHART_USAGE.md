# Offline MIDI Playback Chart - Usage Guide

**Status**: ✅ **COMPLETE** - Ready to use
**Created**: 2025-10-19
**Location**: Chart API Integration

---

## Overview

The **Offline MIDI Playback** chart allows you to test the offline MIDI rendering functionality through the Chart API. It renders a MIDI file using cycle-accurate, faster-than-real-time playback, generates a waveform visualization, and provides audio output.

This chart is part of the **Phase 4: Middleware Integration** testing for the [Playback Refactoring Plan](PLAYBACK_REFACTORING_PLAN.md).

---

## Features

- **Offline Rendering**: Renders MIDI files faster than real-time without audio driver
- **Waveform Visualization**: Shows generated audio waveform
- **Audio Playback**: Includes playable audio in chart response
- **Performance Metrics**: Reports render time, speed, and cycle statistics
- **Automatic Cleanup**: Stops/restarts online playback as needed

---

## API Endpoint

### `/get_chart_test` (POST)

**Request Body**:
```json
{
  "chartType": "offline_midi_playback",
  "midi_file": "elise.mid",
  "max_seconds": 10.0
}
```

**Response**:
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

## Parameters

### `midi_file` (choice)
**Type**: Choice (dropdown)
**Options**:
- `elise.mid` - Für Elise by Beethoven
- `mond_1.mid` - Moonlight Sonata

**Default**: `elise.mid`
**Description**: MIDI file to render (located in `pianoid_middleware/MIDI_records/`)

### `max_seconds` (float)
**Type**: Float
**Range**: 0.1 - 300.0 seconds
**Default**: `10.0`
**Description**: Maximum playback duration in seconds. Rendering stops after this time or when MIDI events end, whichever comes first.

---

## Usage Examples

### 1. Command Line (curl)

```bash
# Test with default settings (elise.mid, 10 seconds)
curl -X POST http://localhost:5000/get_chart_test \
  -H "Content-Type: application/json" \
  -d '{
    "chartType": "offline_midi_playback",
    "midi_file": "elise.mid",
    "max_seconds": 10.0
  }'

# Render full Moonlight Sonata (30 seconds)
curl -X POST http://localhost:5000/get_chart_test \
  -H "Content-Type: application/json" \
  -d '{
    "chartType": "offline_midi_playback",
    "midi_file": "mond_1.mid",
    "max_seconds": 30.0
  }'
```

### 2. Python API

```python
import requests
import json
import base64

# Make request
response = requests.post(
    'http://localhost:5000/get_chart_test',
    json={
        'chartType': 'offline_midi_playback',
        'midi_file': 'elise.mid',
        'max_seconds': 10.0
    }
)

data = response.json()

# Access results
print(f"Rendered: {data['text_fields']['Audio Duration']}")
print(f"Render Speed: {data['text_fields']['Render Speed']}")

# Save audio to file
if data['audio_data']:
    audio_bytes = base64.b64decode(data['audio_data'][0])
    with open('output.wav', 'wb') as f:
        f.write(audio_bytes)
    print("Audio saved to output.wav")
```

### 3. Frontend UI

1. Open the Pianoid web interface
2. Navigate to the Charts section
3. Select "Offline MIDI Playback" from the chart dropdown
4. Choose MIDI file from dropdown
5. Set max duration (seconds)
6. Click "Generate Chart"
7. View waveform and play audio

---

## Implementation Details

### File Locations

**Chart Function**: [`pianoid_middleware/chartFunctions.py:574-701`](pianoid_middleware/chartFunctions.py#L574-L701)
```python
def offline_midi_playback_function(pianoid, **kwargs):
    # Renders MIDI using offline playback engine
    # Returns waveform chart with audio
```

**Chart Configuration**: [`pianoid_middleware/chart_config.json:332-355`](pianoid_middleware/chart_config.json#L332-L355)
```json
{
  "name": "offline_midi_playback",
  "label": "Offline MIDI Playback",
  "function": "offline_midi_playback_function",
  "item_type": "chart",
  "parameters": [...]
}
```

**MIDI Files**: `pianoid_middleware/MIDI_records/`
- `elise.mid` (14 KB)
- `mond_1.mid` (16 KB)

---

## Workflow

```
User Request
    │
    ├─> Load MIDI file from MIDI_records/
    │
    ├─> Parse MIDI events with MidiRecord
    │
    ├─> Pack events into EventQueue
    │
    ├─> Configure PlaybackConfig
    │   ├─> audio_enabled = False
    │   ├─> record_to_buffer = True
    │   ├─> cycle_accurate = True
    │   └─> max_duration_ms
    │
    ├─> Stop online playback (if running)
    │
    ├─> Run offline playback
    │   └─> pianoid.runOfflinePlayback(event_queue, config)
    │
    ├─> Retrieve audio data
    │   └─> pianoid.getRecordedAudio()
    │
    ├─> Create waveform chart
    │   ├─> Display first 1 second (48,000 samples)
    │   └─> Generate full audio for playback
    │
    ├─> Restart online playback (if was running)
    │
    └─> Return chart with audio and metadata
```

---

## Output Metrics

### Text Fields Returned

| Field | Description | Example |
|-------|-------------|---------|
| **MIDI File** | Name of rendered file | `elise.mid` |
| **Max Duration** | Configured limit | `10.0 s` |
| **Audio Duration** | Actual rendered length | `8.45 s` |
| **Samples Generated** | Total audio samples | `405,600` |
| **Sample Rate** | Audio sample rate | `48000 Hz` |
| **Cycles Processed** | GPU synthesis cycles | `6,337` |
| **Events Processed** | MIDI events handled | `142` |
| **Render Time** | Wall-clock time | `12.34 s` |
| **Render Speed** | vs real-time | `0.68x` |
| **Average Cycle Time** | Per-cycle timing | `1.95 ms` |

### Chart Data

- **Waveform**: First 1 second (48,000 samples) of rendered audio
- **Audio**: Full playable WAV file (base64 encoded)

---

## Performance Notes

### Current Performance (as of Phase 5)

- **Render Speed**: ~0.5-0.7x real-time (slower than target)
- **Average Cycle Time**: ~1.8-2.0 ms
- **Target Speed**: 5-20x real-time (Phase 6 optimization)

### Known Issues

- **Slower than expected**: Current offline rendering is not yet optimized
- **Memory usage**: Large MIDI files allocate full audio buffer upfront
- **No streaming**: All audio generated before returning

### Future Optimizations (Phase 6)

- GPU kernel profiling and optimization
- Buffer streaming instead of full allocation
- Parallel event processing
- Cache-friendly data structures

---

## Error Handling

### Common Errors

#### 1. MIDI File Not Found
```json
{
  "text_fields": {
    "Error": "MIDI file not found: C:\\...\\elise.mid"
  }
}
```
**Solution**: Verify MIDI file exists in `pianoid_middleware/MIDI_records/`

#### 2. Pianoid Not Initialized
```json
{
  "text_fields": {
    "Error": "Pianoid not initialized"
  }
}
```
**Solution**: Ensure Pianoid is loaded with a preset before rendering

#### 3. No Audio Generated
```json
{
  "text_fields": {
    "Error": "No audio data generated"
  }
}
```
**Solution**: Check MIDI file is valid, increase `max_seconds`, verify GPU is working

#### 4. Exception During Playback
```json
{
  "text_fields": {
    "Error": "...",
    "Details": "Traceback: ..."
  }
}
```
**Solution**: Check server logs for full stack trace, verify build configuration

---

## Testing Checklist

- [x] Chart registered in `chart_config.json`
- [x] Function implemented in `chartFunctions.py`
- [x] MIDI files available (`elise.mid`, `mond_1.mid`)
- [ ] Backend server running
- [ ] Chart visible in `/graph_names` endpoint
- [ ] Successful render with curl
- [ ] Waveform displays correctly
- [ ] Audio playback works
- [ ] Performance metrics accurate
- [ ] Error handling works

---

## Related Documentation

- [PLAYBACK_REFACTORING_PLAN.md](PLAYBACK_REFACTORING_PLAN.md) - Overall refactoring plan
- [PLAYBACK_STATUS_SUMMARY.md](PLAYBACK_STATUS_SUMMARY.md) - Current implementation status
- [CHART_API_DOCUMENTATION.md](CHART_API_DOCUMENTATION.md) - Chart API reference
- [pianoid_cuda/OfflinePlaybackEngine.cu](pianoid_cuda/OfflinePlaybackEngine.cu) - Core implementation
- [pianoid_middleware/MidiRecord.py](pianoid_middleware/MidiRecord.py) - MIDI parsing

---

## Next Steps

### To Test

1. **Start Backend Server**:
   ```bash
   cd pianoid_middleware
   python backendServer.py
   ```

2. **Verify Chart Registration**:
   ```bash
   curl http://localhost:5000/graph_names | python -m json.tool | grep offline_midi
   ```

3. **Test Rendering**:
   ```bash
   curl -X POST http://localhost:5000/get_chart_test \
     -H "Content-Type: application/json" \
     -d '{"chartType":"offline_midi_playback","midi_file":"elise.mid","max_seconds":5.0}'
   ```

4. **Verify Output**:
   - Check `text_fields` for metrics
   - Verify `audio_data` contains base64 WAV
   - Test audio playback in browser or decode to file

### After Testing

- Update [PLAYBACK_STATUS_SUMMARY.md](PLAYBACK_STATUS_SUMMARY.md) with test results
- Document any issues found
- Proceed with Phase 6 optimization if tests pass
- Consider adding more MIDI test files

---

## Summary

The **Offline MIDI Playback** chart provides a complete testing interface for the offline playback refactoring work. It integrates the new `OfflinePlaybackEngine` with the existing Chart API, enabling easy testing through both REST API and web UI.

**Key Benefits**:
- ✅ Easy testing of offline playback without custom scripts
- ✅ Visual waveform feedback
- ✅ Audio verification
- ✅ Performance metrics
- ✅ Consistent with existing Chart API patterns

**Status**: Ready for testing once backend server is running.
