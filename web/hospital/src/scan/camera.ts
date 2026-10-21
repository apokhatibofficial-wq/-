/**
 * Camera QR reading (SCREENS.md §4): the camera is requested only after the "Turn on camera" tap, back camera first.
 * Decodes with the browser's BarcodeDetector where it exists (Android Chrome), otherwise with jsQR on video frames
 * (iPhone Safari, desktop Chrome). jsQR is loaded only in that case. Stops itself after the first code.
 */
type Detector = { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };

export type CameraError = 'denied' | 'none';

export class QrCamera {
  private stream: MediaStream | null = null;
  private stopped = false;
  private frame = 0;

  constructor(private video: HTMLVideoElement, private onCode: (code: string) => void) {}

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw 'none' satisfies CameraError;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (e) {
      throw ((e as DOMException)?.name === 'NotAllowedError' || (e as DOMException)?.name === 'SecurityError' ? 'denied' : 'none') satisfies CameraError;
    }
    this.stopped = false;
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', 'true');
    await this.video.play().catch(() => undefined);
    const Native = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    let detect: (v: HTMLVideoElement) => Promise<string | null>;
    if (Native) {
      const det = new Native({ formats: ['qr_code'] });
      detect = async v => (await det.detect(v))[0]?.rawValue ?? null;
    } else {
      const { default: jsQR } = await import('jsqr');
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      detect = async v => {
        if (!v.videoWidth) return null;
        // Downscale large frames: enough for a ticket QR, much cheaper per frame.
        const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
        canvas.width = Math.round(v.videoWidth * scale);
        canvas.height = Math.round(v.videoHeight * scale);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
      };
    }
    const loop = async () => {
      if (this.stopped) return;
      try {
        const code = await detect(this.video);
        if (code && !this.stopped) { this.stop(); this.onCode(code); return; }
      } catch { /* a frame that cannot be read yet */ }
      this.frame = requestAnimationFrame(() => void loop());
    };
    void loop();
  }

  stop() {
    this.stopped = true;
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
