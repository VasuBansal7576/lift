export type CaptureFinishIo = {
  stopFfmpeg: () => Promise<void>;
  exists: (file: string) => boolean;
  rm: (file: string) => void;
  publish: (file: string) => void;
};

/** Stop ffmpeg; only remux/publish when ok. A thrown capture must leave no mp4. */
export async function finishCapture(
  ok: boolean,
  outFile: string,
  io: CaptureFinishIo,
): Promise<void> {
  await io.stopFfmpeg();
  if (!ok) {
    if (io.exists(outFile)) io.rm(outFile);
    return;
  }
  io.publish(outFile);
}
