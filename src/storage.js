import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Job } from "./models.js";
export const s3 = new S3Client({
  region: process.env.AWS_REGION || "ap-south-1",
});
const maxUploadBytes = () => {
  const n = Number(process.env.MAX_UPLOAD_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 100 * 1024 * 1024;
};
const bucket = () => {
  const name = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET;
  if (!name) throw Error("Configure S3_BUCKET or AWS_S3_BUCKET before uploading");
  return name;
};
const objectKey = (c) => {
  const base = `calls/${c.agent}/${c.id}/original`;
  const prefix = (process.env.AWS_S3_PREFIX || "").replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${base}` : base;
};
export async function presign(c, { bytes, contentType = "audio/ogg" }) {
  const cap = maxUploadBytes();
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > cap)
    throw Error(`Recording must be 1 byte–${cap} bytes`);
  if (
    !["audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav"].includes(contentType)
  )
    throw Error("Unsupported audio type");
  if (c.recordingStatus === "uploaded")
    throw Error("A recording is already attached");
  c.recordingKey = objectKey(c);
  c.recordingBytes = bytes;
  c.recordingStatus = "uploading";
  await c.save();
  return {
    url: await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucket(),
        Key: c.recordingKey,
        ContentType: contentType,
        ContentLength: bytes,
        ServerSideEncryption: "AES256",
      }),
      { expiresIn: 900 }
    ),
    contentType,
    headers: {
      "Content-Type": contentType,
      "x-amz-server-side-encryption": "AES256",
    },
  };
}
export async function completeUpload(c) {
  if (!c.recordingKey) throw Error("Start upload first");
  const h = await s3.send(
    new HeadObjectCommand({ Bucket: bucket(), Key: c.recordingKey })
  );
  if (h.ContentLength !== c.recordingBytes)
    throw Error("Upload size does not match");
  c.recordingStatus = "uploaded";
  c.aiStatus = "queued";
  await c.save();
  await Job.updateOne(
    { key: `ai:${c.id}` },
    { $setOnInsert: { call: c.id, status: "pending", nextAt: new Date() } },
    { upsert: true }
  );
  return c;
}
export async function playback(c) {
  if (c.recordingStatus !== "uploaded") throw Error("No uploaded recording");
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket(), Key: c.recordingKey }),
    { expiresIn: 300 }
  );
}
