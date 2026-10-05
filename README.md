# Star Dust

Star Dust is a local image-to-video studio that works offline with ffmpeg and no GPU. `docker compose up --build` opens the included Harbor dusk sample: render a mock mp4 and download it.

![Star Dust studio with the Harbor dusk sample](docs/studio-home.png)

![Harbor dusk sample, Slow Zoom In, finished mp4](docs/harbor-dusk.gif)

![Harbor dusk shot list rendered and stitched in the studio](docs/studio-stitch.png)

Mock is camera motion only — a Ken Burns move on the still, not AI motion. The shot list is the product: one clip from a still, render the list in order, then export one stitched mp4. That stitch is ffmpeg. It is not another model.

## Docker

```bash
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). Harbor dusk is already on the studio page, with two shots and a still. Leave the provider on **Mock**, choose **Render all**, then **Export stitch** or download the mp4.

The app listens on port 3000. Clips and the SQLite database stay in `./data` on the host. Keys are not baked into the image. If you later point at fal or Replicate, pass `FAL_KEY` or `REPLICATE_API_TOKEN` in the environment.

## Providers

| Provider | What you need |
| --- | --- |
| Mock | No key. Camera motion only (ffmpeg Ken Burns). Not AI motion. |
| fal | `FAL_KEY` |
| Replicate | `REPLICATE_API_TOKEN` |
| ComfyUI | A reachable server, plus the shipped image-to-video workflow. Not a node editor. |

Before a fal or Replicate job is created, Star Dust shows the model name. A key is required. Some vendors bill failed generations, and unused credits can expire. This app does not invent a price, because the provider did not return one.

If the key is missing, the job is not marked running. The error names `FAL_KEY` or `REPLICATE_API_TOKEN`.

ComfyUI posts `workflows/comfyui-svd-i2v.api.json`, polls `/history`, and downloads the video. If the server is down, the job fails with the URL and the status. The graph is Stable Video Diffusion. It does not read the text prompt, and it does not take a second reference image. The job says so.

A pinned character sheet is sent only when the call has a reference-image input. Mock, the shipped ComfyUI workflow, and the default fal and Replicate calls do not. The face will not match the sheet.

## Shot list

1. **Shot list** — start image, optional end image, prompt, duration, preset.
2. **Render all** — shots run in order.
3. **Export stitch** — completed shots become one mp4.

Gallery: download one clip, or download all as a zip. Jobs can be cancelled and retried.

## Local install

ffmpeg is required (`ffmpeg -version`).

```bash
npm install
cp .env.example .env.local   # only when you use fal or Replicate
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

```bash
npm run demo
```

`npm run demo` renders one mock mp4 from the sample still and exits 0. No API key.

```bash
npm run lint
npm run build
npm run test:providers
```

`test:providers` checks the minor-content refusal (the image is not stored), missing-key failures, a ComfyUI stand-in that queues, polls, and downloads, and a local stitch. It does not call fal, Replicate, or a real ComfyUI server.

## Safety

Star Dust refuses sexual content involving a minor before a job is queued and does not store that image.

## This release, and a hosted pack later

This repository is the local studio, MIT licensed. Run it on your machine. Bring your own cloud key if you want one.

A hosted pack — accounts and billing — is not in this release. Nothing here charges a card. The shot list, the render queue, and the stitch are the surface that pack would sit on.

## Layout

```
src/app/                 studio UI and API
src/lib/storage.ts       SQLite (data/star-dust.sqlite)
src/lib/providers/       mock, fal, Replicate, ComfyUI
workflows/               shipped ComfyUI image-to-video graph
samples/                 Harbor dusk still and shot list
```
