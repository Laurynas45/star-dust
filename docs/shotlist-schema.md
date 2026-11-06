# Shot list file

Schema: `stardust.shotlist/1`

A shot list is `shotlist.json` plus the stills it names. Export shot list puts both in a zip. Import reads that zip, or the JSON file when the stills sit next to it (paths are relative, inside the zip or the folder). The whole file is checked before a project is created. Every problem is listed. Nothing is stored while the file is invalid.

Import always creates a new project. It does not overwrite one you already have. Sexual content involving a minor is refused before a project, a still, or a job is stored.

API keys, auth headers, environment values, billing rates, and payment or license data are not part of the file and are not written on export.

Mock is camera motion on the still, not AI motion. The file does not lock a character, lip-sync, or build a long film. One clip is still the unit.

`examples/harbor-dusk.shotlist.zip` is the Harbor dusk sample. The same list is also `examples/harbor-dusk/shotlist.json` and `examples/harbor-dusk/stills/harbor-dusk.png`.

```bash
npm run render:shotlist -- examples/harbor-dusk.shotlist.zip
```

That imports into a temporary project, prints a Preflight list, renders with Mock, stitches, and prints the mp4 path. No API key and no server. Preflight does not block the render. `--first` renders and stitches only the first enabled shot. If the file names fal, Replicate, or ComfyUI, the command still uses Mock unless `--provider` is set and the matching environment value is present (`FAL_KEY`, `REPLICATE_API_TOKEN`, or `COMFYUI_BASE_URL`). It says so when it stays on Mock.

After each clip is written, the command prints a note when the file is all black, nearly all black, or does not move, and that clip is left out of the mp4. The command then exits non-zero. `--include-flagged` puts those clips in the stitch. Mock clips are not flagged when `CI` is `true` or `1`. The thresholds are in the README. This does not promise picture quality.

## Top level

| Field | What it is |
| --- | --- |
| `schema` | Must be `stardust.shotlist/1`. |
| `name` | Project name. Required. |
| `description` | Note. A string. Empty is fine. |
| `styleBase` | Shared style / character text. Empty sends each shot prompt alone. Text only, not a character lock. |
| `provider` | `mock`, `fal`, `replicate`, or `comfyui`. The name of the backend. Render all in the studio still uses Settings. |
| `comfyuiWorkflow` | A workflow name, or `null` to inherit the app default. Names: Stable Video Diffusion, Wan 2.2 TI2V-5B, Wan 2.2 14B FLF2V, LTX-2.3 distilled FP8. The internal ids (`svd`, `wan`, `wan-flf`, `ltx`) are not accepted. |
| `comfyLowMemory` | `true`, `false`, or `null` to inherit. |
| `output` | `{ "fps", "width", "height" }`. Each is a number or `null`. `null` leaves that stitch choice to the clips. fps is a whole number from 1 to 60. Width and height are both set, or both `null`, and each is an even number from 16 to 4096. |
| `transition` | The project join. See below. |
| `chainTrimStartFrames` | Whole number from 0 to 4. Default in a new project is 1. |
| `shots` | One object per shot, in order. At least one. At most 200. |

## Transition

```json
{ "mode": "cut", "fadeSec": 0.5, "fadeUnit": "seconds", "fadeFrames": 4 }
```

`mode` is `cut` or `crossfade`. `fadeSec` is from 0.25 to 1. `fadeUnit` is `seconds` or `frames`. `fadeFrames` is a whole number from 0 to 24. A crossfade uses the unit you set. A hard cut keeps the fade fields so the file stays complete.

On a shot, `transition` is that object, or `null` to inherit the project join. The shot value is the join that leads into that shot.

## Shot

| Field | What it is |
| --- | --- |
| `prompt` | Required. The shot action. The style base is not copied into it. |
| `durationSec` | Seconds, from 1 to 10. |
| `preset` | `slow-zoom-in`, `slow-zoom-out`, `pan-right`, or `dramatic-push`. Mock uses this for the camera move. |
| `enabled` | `true` or `false`. `false` leaves the shot out of the stitch and names it. |
| `seed` | A whole number from 0 to 999999999, or `null` when the shot has no stored seed yet. Export writes the number Star Dust would send. |
| `seedPinned` | `true` or `false`. `true` needs a seed number. Pin keeps that number on Retake. It does not lock a character. |
| `images` | `{ "file", "role" }`. `role` is `start` or `end`. One start is required. One end is optional. `file` is a relative path inside the zip or folder, such as `stills/harbor-dusk.png`. No absolute paths and no `..`. |
| `chainFromPrevious` | `true` or `false`. The first shot cannot be `true`. |
| `chainFrameBack` | Whole number from 0 to 12. 0 is the last frame of the previous shot. |
| `chainTrimStartFrames` | Whole number from 0 to 4, or `null` to inherit the project trim. |
| `comfyuiWorkflow` | A workflow name, or `null` to inherit the project, then the app default. |
| `comfyLowMemory` | `true`, `false`, or `null` to inherit. |

Unknown fields are an error. A missing field is an error. A bad duration, an unknown workflow, a missing still, and an unknown schema are all listed together. The file is not partly imported.
