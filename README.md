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

The app listens on port 3000. Clips and the SQLite database stay in `./data` on the host. Keys are not baked into the image. Stripe, PayPal, and a license key are not required. If you later point at fal or Replicate, pass `FAL_KEY` or `REPLICATE_API_TOKEN` in the environment.

## Providers

| Provider | What you need |
| --- | --- |
| Mock | No key. Camera motion only (ffmpeg Ken Burns). Not AI motion. |
| fal | `FAL_KEY` |
| Replicate | `REPLICATE_API_TOKEN` |
| ComfyUI | A reachable server, plus one of the shipped workflows. Not a node editor. |

Before a fal or Replicate job is created, Star Dust shows the model name. A key is required. Some vendors bill failed generations, and unused credits can expire. This app does not fetch a vendor price.

In Settings you can type a per-second rate for each fal or Replicate model. The rate is a plain setting, not a key. Before a paid **Render all**, Star Dust shows seconds times that rate and labels it as your own estimate, not a vendor quote. If no rate is set, it says the cost is unknown and does not show a number. An optional budget cap blocks a paid Render all whose estimate is over the cap. Mock and ComfyUI are not billed here.

If the key is missing, the job is not marked running. The error names `FAL_KEY` or `REPLICATE_API_TOKEN`.

ComfyUI posts the workflow you picked, polls `/history`, and downloads the video. If the server is down, the job fails with the URL and the status.

**Stable Video Diffusion** (`workflows/comfyui-svd-i2v.api.json`) does not read the text prompt, and it does not take a second reference image. The job says so. It expects `svd_xt_1_1.safetensors`.

**Wan 2.2 TI2V-5B** (`workflows/comfyui-wan22-ti2v-5b.api.json`) reads the prompt. Star Dust injects the start image, the prompt, a frame count from the shot duration (16 fps, snapped to the Wan 4n+1 length, capped at 81 frames), and the output size (the still fitted inside 832×480). It does not take the end image. It is one short clip. Place these files on the ComfyUI server:

```
ComfyUI/models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors
ComfyUI/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
ComfyUI/models/vae/wan2.2_vae.safetensors
```

ComfyUI's own notes say this 5B graph fits about 8 GB VRAM with native offloading. That is the target, including a ROCm build of ComfyUI. Star Dust does not install the weights. The loader uses ComfyUI's default weight dtype so offloading stays ComfyUI's job.

A pinned character sheet is sent only when the call has a reference-image input. Mock, both shipped ComfyUI workflows, and the default fal and Replicate calls do not. The face will not match the sheet.

## Shot list

1. **Shot list** — start image, optional end image, prompt, duration, preset.
2. **Preview cut** — every shot renders with Mock and stitches, so you can watch the whole edit for $0. The label is camera motion on stills, not AI motion. Preview clips do not overwrite or count as a shot's take.
3. **Render all** — shots run in order on the provider you picked. A shot is skipped when it already has a completed take for the same provider, model, image(s), prompt, duration, and preset, and when a take is already queued or running. **Re-render** on a shot forces a new take. Previous takes stay on disk and in the database. Pick which take the stitch uses.
4. **Export stitch** — the chosen take of each completed shot becomes one mp4. ffmpeg does that. It is not another model.

Gallery: download one take, or download all takes as a zip. Preview clips stay out of that gallery. Jobs can be cancelled and retried.

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

`test:providers` checks the minor-content refusal (the image is not stored), missing-key failures, a ComfyUI stand-in that queues, polls, and downloads, take skipping, take selection in the stitch, an unknown cost when no rate is set, a budget cap that blocks a paid Render all, Wan workflow injection against that stand-in, and a local stitch. It also checks that Stripe and PayPal left unset stay on that same path, that a signed Stripe webhook and a mocked PayPal capture each grant a credit pack without calling those networks, that a low balance blocks a paid Render all, and that an unset license key still renders Mock. It does not call fal, Replicate, Stripe, PayPal, or a real ComfyUI server.

## Safety

Star Dust refuses sexual content involving a minor before a job is queued and does not store that image.

## Hosted credits / self-hosted pack

Docker, Mock, the shot list, preview cut, and the stitch are the free studio. They need no account, no Stripe key, no PayPal key, and no license key. `npm run demo` stays offline.

**Hosted credits** are one-time packs, not a subscription. There is one balance for this installation, stored in the local SQLite file, not a per-person account. Stripe and PayPal add to that same balance. Either can be set alone, or both.

Stripe turns on with `STRIPE_SECRET_KEY` and a one-time price id. Use `STRIPE_PRICE_CREDITS` (credits come from `STRIPE_CREDITS_AMOUNT`, or 100 if that is empty) or a named pair such as `STRIPE_PRICE_CREDITS_STUDIO` and `STRIPE_CREDITS_STUDIO`. The webhook adds credits after Stripe reports the payment as paid. The same Checkout session cannot add credits twice.

PayPal turns on with `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_PACK_AMOUNT`. `PAYPAL_MODE` is `sandbox` or `live`; empty means sandbox. Credits for that amount come from `PAYPAL_CREDITS_AMOUNT`, then the matching Stripe pack size, then 100. A named pack uses `PAYPAL_PACK_AMOUNT_STUDIO` and `PAYPAL_CREDITS_STUDIO`. Checkout is a PayPal order with intent `CAPTURE`. The server captures it when the buyer returns, and `PAYMENT.CAPTURE.COMPLETED` can confirm the same order when `PAYPAL_WEBHOOK_ID` is set. The same PayPal order cannot add credits twice.

A paid fal or Replicate **Render all** estimates one credit per second (override with `STAR_DUST_CREDITS_PER_SECOND`) and is blocked when the balance is lower. Credits are spent when those jobs are queued. A single shot and a retry use the same balance, so they cannot skip it. The operator's `FAL_KEY` or `REPLICATE_API_TOKEN` still has to be in the environment. Mock, ComfyUI, preview cut, and stitch do not spend credits. If Stripe and PayPal are both unset, the pay buttons stay hidden and Render all behaves as before: your own key, your own per-second rate, and the optional budget cap.

**Self-hosted pack** is optional and does not gate that core. Set `STAR_DUST_LICENSE_KEY` to unlock a local worker plan (`workflows/pack-hold.json`, `npx tsx scripts/pack-worker.ts <projectId>`, and `GET /api/projects/<id>/pack-worker`). Any non-empty value unlocks it. The key is read from the environment only. Star Dust does not call a license server, so an air-gapped Mock render still runs when the key is unset. Without the key, Mock, fal, Replicate, ComfyUI, and the shipped SVD and Wan graphs stay available.

## Layout

```
src/app/                 studio UI and API
src/lib/storage.ts       SQLite (data/star-dust.sqlite), including the optional credit ledger
src/lib/credits.ts       hosted credit balance, off unless Stripe or PayPal packs are set
src/lib/paypal-billing.ts  PayPal order capture for that same balance
src/lib/pack.ts          optional self-hosted pack (local license check)
src/lib/providers/       mock, fal, Replicate, ComfyUI
workflows/               shipped ComfyUI graphs (SVD and Wan 2.2 TI2V-5B) and the optional pack plan
samples/                 Harbor dusk still and shot list
```
