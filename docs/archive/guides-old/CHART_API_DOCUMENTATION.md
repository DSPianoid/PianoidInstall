# Pianoid Chart & Action API Documentation

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [API Endpoints](#api-endpoints)
4. [Adding New Charts](#adding-new-charts)
5. [Adding New Actions](#adding-new-actions)
6. [Configuration Reference](#configuration-reference)
7. [Examples](#examples)

---

## Overview

The Pianoid Chart & Action system provides a flexible, plugin-based architecture for creating data visualizations (charts) and executing operations (actions) through a REST API. The system uses a registry pattern to dynamically load and manage chart types and actions from a JSON configuration file.

### Key Features
- **Dynamic Registration**: Charts and actions are defined in `chart_config.json` and loaded at runtime
- **Type-Safe Parameters**: Each chart/action defines typed parameters with validation
- **Audio Sonification**: Charts can automatically generate audio representations of data
- **Extensible**: New charts and actions can be added without modifying core code
- **Dual Playback Modes**: Support for both real-time and offline playback patterns

### Playback Modes

**IMPORTANT:** Understanding playback modes is critical for chart functions:

#### Real-Time (Online) Playback
- Uses `start_pianoid()` / `stop_pianoid()` lifecycle
- Actual audio output to speakers
- Results fetched via `get_result_from_pianoid()`
- **Use when:** Analyzing live performance, debugging audio issues
- **Example:** Excite note → wait → fetch results → display

**✅ Phase E Complete: Unified EventQueue (v3.0+)**
- **Always enabled** - No configuration needed!
- ~~`PIANOID_UNIFIED_PLAYBACK` environment variable~~ (removed in v3.0)
- Real-time playback uses EventQueue architecture
- Provides cycle-accurate timing (±5 cycles / ±6.67ms)
- Event logging and debugging capabilities
- Legacy online playback code fully removed (546 lines cleaned up)

#### Offline (Batch) Playback
- Uses `EventQueue` + `runOfflinePlayback()`
- No audio output (silent rendering)
- Results fetched via `pianoid.result.fetch()`
- Typically uses `MidiEventConverter.fromMidiBytes()` for event creation
- **Use when:** Deterministic testing, reproducible analysis, automation
- **Example:** Create events → run offline → fetch results → display

**Rule of Thumb:**
- If your chart needs **deterministic, reproducible results** → Use offline playback
- If your chart needs **real audio output** → Use real-time playback (unified EventQueue)
- Most testing/analysis charts should use **offline** mode
- **v3.0+**: Real-time playback always uses EventQueue - best of both worlds!

---

## Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     backendServer.py                         │
│  Flask Routes: /start_test, /get_chart_test, /graph_names   │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ├── Uses ──────────────────────┐
                   │                               │
        ┌──────────▼──────────┐         ┌─────────▼─────────┐
        │  ChartTypeRegistry  │         │  ChartGenerator   │
        │  (ChartRegistry.py) │         │  ActionPerformer  │
        │                     │         │ (ChartGenerator.py)│
        │  - Loads config     │         │                   │
        │  - Manages types    │         │  - Executes logic │
        │  - Validates params │         │  - Returns data   │
        └──────────┬──────────┘         └─────────┬─────────┘
                   │                               │
                   │ Reads                         │ Calls
                   │                               │
        ┌──────────▼──────────┐         ┌─────────▼─────────┐
        │ chart_config.json   │         │ chartFunctions.py │
        │                     │         │                   │
        │ - Chart definitions │         │ - sound_function  │
        │ - Action definitions│         │ - filter_action   │
        │ - Parameter schemas │         │ - profiling_...   │
        └─────────────────────┘         └───────────────────┘
```

### Core Classes

#### 1. **ChartTypeRegistry** ([ChartRegistry.py:321-493](pianoid_middleware/ChartRegistry.py#L321-L493))
The central registry that manages all available chart types and actions.

**Key Methods:**
- `register_type(chart_type)` - Register a new chart or action
- `get_type(name, item_type)` - Retrieve a registered type
- `get_charts()` / `get_actions()` - Filter by type
- `graph_names_json()` / `action_names_json()` - Export for frontend
- `sync_config_file()` - Save registry to JSON

#### 2. **ChartType** ([ChartRegistry.py:249-319](pianoid_middleware/ChartRegistry.py#L249-L319))
Represents a single chart or action type.

**Attributes:**
- `chart_name` - Unique identifier
- `label` - Human-readable name
- `processing_function` - Name of function in `chartFunctions.py`
- `item_type` - Either `"chart"` or `"action"`
- `parameters` - List of `ChartParameter` objects

**Key Methods:**
- `extract_arguments(**kwargs)` - Parse and validate parameters
- `render(pianoid, **kwargs)` - Execute chart generation
- `execute(pianoid, **kwargs)` - Execute action

#### 3. **ChartParameter** ([ChartRegistry.py:206-247](pianoid_middleware/ChartRegistry.py#L206-L247))
Defines a single parameter with type validation.

**Supported Types:**
- `string` - Text input
- `number` / `int` - Integer values
- `float` - Decimal values
- `boolean` - True/false
- `choice` - Select from predefined options

#### 4. **ChartGenerator** ([ChartGenerator.py:23-68](pianoid_middleware/ChartGenerator.py#L23-L68))
Executes chart generation functions and formats responses.

**Flow:**
1. Receives chart type and parameters
2. Validates and extracts arguments
3. Calls processing function from `chartFunctions.py`
4. Formats response with data, headers, and optional audio

#### 5. **ActionPerformer** ([ChartGenerator.py:72-111](pianoid_middleware/ChartGenerator.py#L72-L111))
Executes action functions.

**Flow:**
1. Receives action type and parameters
2. Validates arguments
3. Calls processing function
4. Returns status message

---

## API Endpoints

### 1. `/start_test` - Execute Actions
**Method:** `POST`

**Description:** Execute an action (e.g., toggle filter, start profiling, etc.)

**Request Body:**
```json
{
  "action_type": "filter",
  "toggle": true,
  "file": "Bluthner.fir"
}
```

**Response:**
```json
{
  "Message": "OK"
}
```

**Route Implementation:** [backendServer.py:621-652](pianoid_middleware/backendServer.py#L621-L652)

**Flow:**
1. Extract `action_type` from request
2. Look up action in `ChartTypeRegistry`
3. Create `ActionPerformer` with validated parameters
4. Execute action function
5. Return status message

---

### 2. `/get_chart_test` - Generate Charts
**Method:** `POST`

**Description:** Generate a chart with visualization data and optional audio

**Request Body:**
```json
{
  "chartType": "sound",
  "length": 24000,
  "channel": 0
}
```

**Response:**
```json
{
  "data": [[0.1, 0.2, 0.15, ...]],
  "general_header": "Sound record",
  "text_fields": {
    "Sound obtained": "Length 500.00 ms, channels 2",
    "Sound displayed": "Length 500.00 ms, channel 0"
  },
  "chart_headers": [""],
  "audio_data": ["base64_encoded_wav_data"]
}
```

**Route Implementation:** [backendServer.py:590-619](pianoid_middleware/backendServer.py#L590-L619)

---

### 3. `/graph_names` - Get Available Charts and Actions
**Method:** `GET`

**Description:** Retrieve lists of all available charts and actions with their parameters

**Response:**
```json
{
  "graphs": [
    {
      "name": "sound",
      "label": "Sound Analysis",
      "parameters": [
        {
          "name": "length",
          "type": "number",
          "label": "Length",
          "defaultValue": 10000
        },
        {
          "name": "channel",
          "type": "number",
          "label": "Channel Number",
          "defaultValue": 0
        }
      ]
    }
  ],
  "actions": [
    {
      "name": "filter",
      "label": "Filter",
      "parameters": [
        {
          "name": "toggle",
          "type": "boolean",
          "defaultValue": false,
          "label": "On/Off"
        }
      ]
    }
  ],
  "message": "OK"
}
```

**Route Implementation:** [backendServer.py:212-237](pianoid_middleware/backendServer.py#L212-L237)

---

## Adding New Charts

### Step 1: Create the Processing Function

Add a new function to [chartFunctions.py](pianoid_middleware/chartFunctions.py):

```python
def my_new_chart_function(pianoid, **kwargs):
    """
    Generate my custom chart

    Args:
        pianoid: Pianoid instance
        **kwargs: Parameters defined in chart_config.json

    Returns:
        tuple: (charts, top_header, text_fields)
    """
    charts = ChartArray()
    text_fields = {}

    # Extract parameters
    param1 = kwargs.get('param1', default_value)
    param2 = kwargs.get('param2', default_value)

    # Generate your data
    data = # ... your logic here

    # Add chart(s)
    charts.append_chart("My Chart Title", data)

    # Optional: Create audio sonification
    charts.create_audio_to_chart('all', sample_rate=pianoid.mp.sample_rate())

    # Set metadata
    top_header = "My Custom Chart"
    text_fields = {
        "Parameter 1": str(param1),
        "Data Length": str(len(data))
    }

    return charts, top_header, text_fields
```

**Important:**
- Function must accept `pianoid` as first parameter
- Must accept `**kwargs` for parameters
- Must return `(ChartArray, str, dict)` tuple
- Data should be numpy arrays or lists

---

### Step 2: Add Configuration to chart_config.json

Add a new entry to [chart_config.json](pianoid_middleware/chart_config.json):

```json
{
  "name": "my_new_chart",
  "label": "My Custom Chart",
  "function": "my_new_chart_function",
  "item_type": "chart",
  "parameters": [
    {
      "name": "param1",
      "type": "number",
      "label": "First Parameter",
      "defaultValue": 100
    },
    {
      "name": "param2",
      "type": "string",
      "label": "Second Parameter",
      "defaultValue": "default_value"
    }
  ]
}
```

**Configuration Fields:**
- `name` - Unique identifier (used in API requests)
- `label` - Display name for UI
- `function` - Name of function in `chartFunctions.py`
- `item_type` - Must be `"chart"`
- `parameters` - Array of parameter definitions

---

### Step 3: Restart the Server

The registry automatically loads `chart_config.json` on startup. Restart the Flask server to load your new chart.

---

### Step 4: Test Your Chart

```bash
curl -X POST http://localhost:5000/get_chart_test \
  -H "Content-Type: application/json" \
  -d '{
    "chartType": "my_new_chart",
    "param1": 200,
    "param2": "test_value"
  }'
```

---

## Adding New Actions

### Step 1: Create the Action Function

Add to [chartFunctions.py](pianoid_middleware/chartFunctions.py):

```python
def my_action_function(pianoid, **kwargs):
    """
    Execute my custom action

    Args:
        pianoid: Pianoid instance
        **kwargs: Parameters from chart_config.json

    Returns:
        str or dict: Status message or result
    """
    # Extract parameters
    enable = kwargs.get('enable', False)
    value = kwargs.get('value', 0)

    # Execute your logic
    if enable:
        pianoid.some_method(value)
        return "Action executed successfully"
    else:
        return "Action disabled"
```

**Important:**
- Actions return status strings or dicts
- Actions do NOT return `ChartArray` (that's for charts only)
- Return `"OK"` for success, or descriptive error messages

---

### Step 2: Add Configuration

Add to [chart_config.json](pianoid_middleware/chart_config.json):

```json
{
  "name": "my_action",
  "label": "My Custom Action",
  "function": "my_action_function",
  "item_type": "action",
  "parameters": [
    {
      "name": "enable",
      "type": "boolean",
      "defaultValue": false,
      "label": "Enable Action"
    },
    {
      "name": "value",
      "type": "number",
      "defaultValue": 100,
      "label": "Action Value"
    }
  ]
}
```

**Key difference from charts:**
- `item_type` must be `"action"`

---

### Step 3: Test Your Action

```bash
curl -X POST http://localhost:5000/start_test \
  -H "Content-Type: application/json" \
  -d '{
    "action_type": "my_action",
    "enable": true,
    "value": 500
  }'
```

---

## Configuration Reference

### Parameter Types

#### `string`
```json
{
  "name": "filename",
  "type": "string",
  "label": "File Name",
  "defaultValue": "output.wav"
}
```

#### `number` / `int`
```json
{
  "name": "count",
  "type": "number",
  "label": "Count",
  "defaultValue": 100
}
```

#### `float`
```json
{
  "name": "threshold",
  "type": "float",
  "label": "Threshold",
  "defaultValue": 0.5
}
```

#### `boolean`
```json
{
  "name": "enabled",
  "type": "boolean",
  "label": "Enable Feature",
  "defaultValue": false
}
```

#### `choice` (dropdown)
```json
{
  "name": "mode",
  "type": "choice",
  "label": "Operation Mode",
  "choices": ["fast", "normal", "accurate"],
  "defaultValue": "normal"
}
```

**Important:**
- `choice` type requires `choices` array
- `defaultValue` must be in `choices` list

---

## Examples

### Example 1: Simple Data Chart

**Function:** ([chartFunctions.py:250-302](pianoid_middleware/chartFunctions.py#L250-L302))
```python
def block_output_data_function(pianoid, **kwargs):
    """Standalone function for block output data chart

    Data structure: output_data[record_no][string_no][position]
    In CUDA, strings are organized in blocks (4 strings per block)
    """
    charts = ChartArray()
    num_charts = kwargs.get('num_charts', 1)
    record_no = kwargs.get('record_no', 0)
    block_no = kwargs.get('block_no', 0)
    pitch_no = kwargs.get('pitch_no', -1)

    # Fetch output_data from GPU
    pianoid.result.get_output_data_from_pianoid()

    # Determine which blocks to display
    if pitch_no >= 0:
        # Get all string IDs for this pitch
        string_ids = pianoid.sm.get_string_IDs(pitch_no)
        # Strings are organized in blocks (num_strings_in_array strings per block)
        # All strings for a pitch are in the same block
        if len(string_ids) > 0:
            # Calculate block number from first string ID
            block_num = string_ids[0] // pianoid.mp.num_strings_in_array
            blocks_to_display = [block_num]
        else:
            blocks_to_display = []

        top_header = f"Block Output Data for Pitch {pitch_no}"
        text_fields = {
            "Data shape": str(pianoid.result.output_data.shape),
            "Record number": str(record_no),
            "Pitch number": str(pitch_no),
            "Strings for pitch": str(string_ids),
            "Block number": str(blocks_to_display[0] if blocks_to_display else "N/A")
        }
    else:
        # Use block_no and num_charts
        blocks_to_display = list(range(block_no, block_no + num_charts))
        top_header = "Block Output Data"
        text_fields = {
            "Data shape": str(pianoid.result.output_data.shape),
            "Record number": str(record_no),
            "Starting block": str(block_no),
            "Num charts": str(num_charts)
        }

    # Create charts for each block
    for block in blocks_to_display:
        chart = pianoid.result.output_data[record_no][block]
        charts.append_chart(f"Record {record_no}, Block {block}", chart)

    return charts, top_header, text_fields
```

**Config:** ([chart_config.json:142-172](pianoid_middleware/chart_config.json#L142-L172))
```json
{
  "name": "block_output_data",
  "label": "Block Output Data",
  "function": "block_output_data_function",
  "item_type": "chart",
  "parameters": [
    {
      "name": "num_charts",
      "type": "number",
      "label": "Number of Charts",
      "defaultValue": 1
    },
    {
      "name": "record_no",
      "type": "number",
      "label": "Record Number (0-9)",
      "defaultValue": 9
    },
    {
      "name": "block_no",
      "type": "number",
      "label": "Block Number (String)",
      "defaultValue": 0
    },
    {
      "name": "pitch_no",
      "type": "number",
      "label": "Pitch Number (-1 for none)",
      "defaultValue": -1
    }
  ]
}
```

**Data Structure:**
- `output_data` has shape `(num_states, num_strings, array_size)` = `(10, num_strings, array_size)`
- In CUDA, data is written using `recordOutputData(&output_data[numStrings * arraySize * record_no], blockNo, arraySize, position, value)`
- **Important:** In CUDA kernel code, `blockNo` refers to the thread block index, but strings are organized in blocks of 4 (num_strings_in_array)
- For a system with 224 strings, there are 224/4 = 56 CUDA thread blocks
- All strings for a given pitch are located in the same CUDA thread block

**Usage:**
- **By block range**: Set `pitch_no=-1`, then use `block_no` and `num_charts` to display a range of blocks
- **By pitch**: Set `pitch_no` to a MIDI pitch number (e.g., 62), and the chart will automatically calculate the block number containing that pitch's strings and display a single chart for that block
  - Example: pitch 62 has strings [176, 177, 178], which are in block 44 (176 // 4 = 44)

---

## Debug Output Data Slots

The `output_data` buffer in MainKernel.cu has 10 record slots (0-9) for debug information:

### Reserved Slots (Always Available)
- **Record 0**: `s_a` - Current string state
- **Record 1**: `s_b` - Previous string state
- **Record 2**: String identification data

### Feedback Coefficient Diagnostic Slots (Records 3-9)

Optimized for feedback coefficient verification and debugging:

| Record | Data | Description | Usage |
|--------|------|-------------|-------|
| **3** | `coeff_force` | Spatial hammer force distribution | Gaussian profile along string |
| **4** | `mode_feedin[i]` | Feedin coefficients used in coupling | String→Mode coupling strength |
| **5** | `mode_feedback[i]` | Computed feedback (feedin × coeff) | Mode→String coupling strength |
| **6** | `feedin_cycle_matrix` | String→Mode force accumulation | Energy flow to modes |
| **7** | `feedback_cycle_matrix` | Mode→String displacement accumulation | Energy flow to strings |
| **8** | `feedback` | Final feedback value at stem | Actual displacement applied |
| **9** | `mode_coefficients` | Raw FEEDIN matrix from GPU memory | Verify preset loading |

**Note:** Records 3-9 can be repurposed for other debugging tasks as needed. Only records 0-2 are permanently reserved.

### Verification Workflow

**To verify feedback coefficient is working:**

1. **Set coefficient to known value:**
   ```bash
   curl -X POST http://localhost:5000/set_runtime_parameters \
     -H "Content-Type: application/json" \
     -d '{"feedback": 0.5}'
   ```

2. **Play a note** (realtime or offline)

3. **Use feedback diagnostic chart:**
   ```bash
   curl -X POST http://localhost:5000/get_chart_test \
     -H "Content-Type: application/json" \
     -d '{
       "chartType": "feedback_diagnostic",
       "parameters": {"pitch_no": 60, "num_modes": 50}
     }'
   ```

4. **Check results:**
   - "Coefficient (Python API)" shows the value being used
   - "Max Error" should be < 1e-6
   - Status should show "✅ PASS"

### Hammer Spatial Distribution Chart

**To visualize spatial hammer force distribution:**

```bash
curl -X POST http://localhost:5000/get_chart_test \
  -H "Content-Type: application/json" \
  -d '{
    "chartType": "hammer_shape",
    "parameters": {"pitch_no": 60}
  }'
```

This shows the Gaussian spatial distribution of hammer force along the string length.
The peak location indicates the hammer strike point, and the width shows the contact area.

---

### Example 2: Chart with Audio

**Function:** ([chartFunctions.py:7-23](pianoid_middleware/chartFunctions.py#L7-L23))
```python
def sound_function(pianoid, **kwargs):
    charts = ChartArray()
    length = kwargs.get('length', 24000)
    channel = kwargs.get('channel', 0)

    sound = pianoid.result.get_sound(channel=-1)
    data = sound[channel][:length]
    sr = pianoid.mp.sample_rate() / 1000

    charts.append_chart("", data)
    charts.create_audio_to_chart('all', sample_rate=pianoid.mp.sample_rate())

    top_header = "Sound record"
    text_fields = {
        "Sound obtained": f"Length {sound.shape[1] / sr:.2f} ms, channels {sound.shape[0]}"
    }
    return charts, top_header, text_fields
```

The `create_audio_to_chart()` method automatically sonifies the data and encodes it as base64 WAV.

---

### Example 3: Action with Choice Parameter

**Function:** ([chartFunctions.py:290-376](pianoid_middleware/chartFunctions.py#L290-L376))
```python
def profiling_action(pianoid, **kwargs):
    cuda_pianoid = pianoid.pianoid
    action = kwargs.get('action', '').lower()

    if action == 'start':
        cuda_pianoid.startProfiling()
        return {"status": "success", "message": "Profiling started"}
    elif action == 'stop':
        cuda_pianoid.stopProfiling()
        return {"status": "success", "message": "Profiling stopped"}
    elif action == 'reset':
        cuda_pianoid.resetProfiling()
        return {"status": "success", "message": "Buffer cleared"}
    else:
        return {"status": "error", "message": f"Invalid action '{action}'"}
```

**Config:** ([chart_config.json:242-272](pianoid_middleware/chart_config.json#L242-L272))
```json
{
  "name": "profiling_start",
  "label": "Start/Stop Profiling",
  "function": "profiling_action",
  "item_type": "action",
  "parameters": [
    {
      "name": "action",
      "type": "choice",
      "defaultValue": "start",
      "label": "Choose",
      "choices": ["start", "stop", "reset"]
    }
  ]
}
```

---

### Example 4: Complex Chart with Multiple Parameters

**Function:** ([chartFunctions.py:78-225](pianoid_middleware/chartFunctions.py#L78-L225))
```python
def filter_test_function(pianoid, **kwargs):
    charts = ChartArray()

    # Extract all parameters
    mode = kwargs.get('mode', "pulses")
    num_inputs = kwargs.get('num_inputs', 1)
    num_outputs = kwargs.get('num_outputs', 1)
    length = kwargs.get('length', 18432)
    save_path = kwargs.get('save_path', '')
    load_from_file = kwargs.get('load_from_file', None)

    # Complex processing logic...
    if load_from_file:
        loaded = load_fir_filters(load_from_file)
        filters = loaded['filters']
    else:
        filters = [dummy_filter(length=length) for _ in range(num_inputs * num_outputs)]

    # Run test and create charts
    result_all, timing = filter_test(input_sound, filters, ...)

    for i, result in enumerate(result_all):
        charts.append_chart(f"Channel {i}", result)

    charts.create_audio_to_chart('all', sample_rate=pianoid.mp.sample_rate())

    return charts, "Filter test", text_fields
```

**Config:** ([chart_config.json:74-140](pianoid_middleware/chart_config.json#L74-L140))
```json
{
  "name": "filter_test",
  "label": "Filter Test",
  "function": "filter_test_function",
  "item_type": "chart",
  "parameters": [
    {
      "name": "mode",
      "type": "choice",
      "label": "Test Mode",
      "choices": ["pianoid", "pulses", "harmonic"],
      "defaultValue": "pianoid"
    },
    {
      "name": "num_outputs",
      "type": "number",
      "label": "Output channels",
      "defaultValue": 1
    },
    {
      "name": "save_path",
      "type": "string",
      "label": "Save filters",
      "defaultValue": "presets/FIRfilterTest.fir"
    },
    {
      "name": "stop_pianoid",
      "type": "boolean",
      "label": "Stop Pianoid",
      "defaultValue": true
    }
  ]
}
```

---

### Example 5: Offline Playback (Mode Excitation)

**IMPORTANT:** This example demonstrates the correct pattern for **offline playback testing**.

**Function:** ([chartFunctions.py:717-887](pianoid_middleware/chartFunctions.py#L717-L887))
```python
def play_mode_chart_function(pianoid, **kwargs):
    """
    Offline playback example: Direct soundboard mode excitation

    Key Pattern:
    1. Create EventQueue
    2. Use MidiEventConverter.fromMidiBytes() to create events
    3. Run runOfflinePlayback()
    4. Fetch results via pianoid.result.fetch()
    """
    import pianoidCuda
    import time

    charts = ChartArray()
    mode_index = kwargs.get('mode_index', 0)
    velocity = kwargs.get('velocity', 100)
    duration_ms = kwargs.get('duration_ms', 2000)

    # Get audio configuration
    sample_rate = pianoid.mp.sample_rate()
    samples_per_cycle = pianoid.mp.mode_iteration

    # Step 1: Create event queue
    event_queue = pianoidCuda.EventQueue()

    # Step 2: Create event using MidiEventConverter
    # 0xF1 = mode excitation custom command
    mode_excite = pianoidCuda.MidiEventConverter.fromMidiBytes(
        0xF1,        # status byte (custom command)
        mode_index,  # data1 (mode index 0-255)
        velocity,    # data2 (velocity 0-127)
        0            # cycle (start at cycle 0)
    )
    event_queue.addEvent(mode_excite)

    # Step 3: Configure offline playback
    config = pianoidCuda.PlaybackConfig()
    config.audio_enabled = False
    config.record_to_buffer = True
    config.cycle_accurate = True
    config.max_duration_ms = duration_ms + 5000
    config.sample_rate = sample_rate
    config.samples_per_cycle = samples_per_cycle

    # Step 4: Run offline playback (deterministic, no audio output)
    with pianoid.cuda_lock:
        pianoid.pianoid.clearRecords()
        stats = pianoid.pianoid.runOfflinePlayback(event_queue, config)

        # Step 5: Fetch results from GPU
        pianoid.result.fetch(duration_ms, pianoid.debug)

    # Step 6: Extract data
    mode_oscillation = pianoid.result.get_record(1, mode_index)
    sound = pianoid.result.get_sound(channel=0)

    # Step 7: Create charts
    charts.append_chart(f"Mode {mode_index} Oscillation", mode_oscillation[:48000])
    charts.append_chart("Generated Sound", sound[:48000])
    charts.create_audio_to_chart('all', sample_rate=int(sample_rate))

    return charts, f"Mode {mode_index} Playback", {...}
```

**Config:** ([chart_config.json:364-402](pianoid_middleware/chart_config.json#L364-L402))
```json
{
  "name": "mode_playback",
  "label": "Mode Playback Test",
  "function": "play_mode_chart_function",
  "item_type": "chart",
  "parameters": [
    {
      "name": "mode_index",
      "type": "number",
      "defaultValue": 0,
      "label": "Mode Index (0-255)"
    },
    {
      "name": "velocity",
      "type": "number",
      "defaultValue": 100,
      "label": "Velocity (0-127)"
    },
    {
      "name": "duration_ms",
      "type": "number",
      "defaultValue": 2000,
      "label": "Duration (ms)"
    }
  ]
}
```

**Why Offline Playback?**
- **Deterministic:** Same inputs always produce same outputs
- **Fast:** No real-time constraints
- **Reproducible:** Perfect for testing and analysis
- **Silent:** No audio driver interference

**Common Mistake:** Using `start_pianoid()` + `processMidiPoints()` for testing
- ❌ Real-time mode is for **live performance**
- ✅ Offline mode is for **testing/analysis**

**See Also:** [MODE_EXCITATION_IMPLEMENTATION_SUMMARY.md](../MODE_EXCITATION_IMPLEMENTATION_SUMMARY.md) for complete implementation details.

---

## Best Practices

### Charts
1. **Always validate parameters** - Use `kwargs.get()` with defaults
2. **Handle edge cases** - Check for empty data, invalid indices
3. **Provide meaningful text fields** - Help users understand the chart
4. **Use appropriate data types** - Numpy arrays for efficiency
5. **Consider audio** - Sonification helps with debugging

### Actions
1. **Return clear status messages** - Help users understand what happened
2. **Handle errors gracefully** - Return error messages, don't crash
3. **Log important operations** - Use `print()` for server logs
4. **Validate state** - Check if pianoid is running/stopped as needed

### Configuration
1. **Use descriptive names** - Both `name` and `label` should be clear
2. **Set sensible defaults** - Common use cases should work without changes
3. **Document complex parameters** - Use clear labels
4. **Group related parameters** - Order matters in UI

---

## Debugging

### Common Issues

#### 1. Function not found
**Error:** `ImportError: Function 'my_function' not found`

**Solution:**
- Check function name matches exactly in `chart_config.json`
- Verify function is defined in `chartFunctions.py`
- Restart Flask server after adding function

#### 2. Invalid parameter type
**Error:** `ValueError: Value 'x' not in valid choices ['a', 'b']`

**Solution:**
- Check `defaultValue` is in `choices` for choice parameters
- Verify frontend sends correct type

#### 3. Chart doesn't appear
**Solution:**
- Check Flask console for errors
- Verify `item_type` is `"chart"` (not `"action"`)
- Test with `/graph_names` to see if registered

#### 4. Action returns error
**Solution:**
- Check Flask console logs (actions print status)
- Verify pianoid is initialized
- Test action function directly in Python

---

## Testing Workflow

### 1. Test from Command Line
```bash
# Get available charts/actions
curl http://localhost:5000/graph_names | python -m json.tool

# Test a chart
curl -X POST http://localhost:5000/get_chart_test \
  -H "Content-Type: application/json" \
  -d '{"chartType":"sound","length":1000}' | python -m json.tool

# Test an action
curl -X POST http://localhost:5000/start_test \
  -H "Content-Type: application/json" \
  -d '{"action_type":"filter","toggle":true}'
```

### 2. Test Processing Function Directly
```python
from pianoid import initialize
from chartFunctions import my_new_chart_function

pianoid = initialize('presets/test.json', ...)
charts, header, fields = my_new_chart_function(pianoid, param1=100)

print(header)
print(fields)
print(charts.get_data())
```

### 3. Validate Configuration
```python
from ChartRegistry import ChartTypeRegistry

registry = ChartTypeRegistry()
chart = registry.get_type('my_new_chart', 'chart')
print(chart.get_parameters())
```

---

## Summary

The Chart & Action API provides:
- **Modular design** - Add features without changing core code
- **Type safety** - Parameter validation prevents errors
- **Rich responses** - Data, metadata, and audio in one call
- **Easy testing** - REST API allows command-line testing
- **Dynamic loading** - Changes require only config edits + restart

To add new functionality:
1. Write processing function in `chartFunctions.py`
2. Add configuration to `chart_config.json`
3. Restart server
4. Test via `/start_test` or `/get_chart_test`

For questions or issues, check the Flask console logs and verify your configuration matches the examples in this document.
