import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import mongoose from "mongoose";
import { Call, Job } from "./models.js";
export const s3 = new S3Client({
  region: process.env.AWS_REGION || "ap-south-1",
  requestChecksumCalculation: "WHEN_REQUIRED",
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
export async function presign(c, { bytes, contentType = "audio/ogg", protocol }) {
  const alreadyUploaded = () => {
    if (protocol === 2) return { uploaded: true };
    throw Object.assign(Error("A recording is already attached"), { status: 409 });
  };
  const cap = maxUploadBytes();
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > cap)
    throw Error(`Recording must be 1 byte–${cap} bytes`);
  if (
    !["audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav"].includes(contentType)
  )
    throw Error("Unsupported audio type");
  if (c.recordingStatus === "uploaded") { await completeUpload(c); return alreadyUploaded(); }
  if (c.recordingStatus === "uploading" && c.recordingKey) {
    let recovered = false;
    try {
      await completeUpload(c);
      recovered = true;
    } catch (error) {
      if (![403, 404].includes(error.$metadata?.httpStatusCode) && error.name !== "NotFound" && error.name !== "NoSuchKey") throw error;
    }
    if (recovered) return alreadyUploaded();
  }
  const key = c.recordingKey || objectKey(c);
  const signed = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType,
      ContentLength: bytes, ServerSideEncryption: "AES256", IfNoneMatch: "*" }),
    { expiresIn: 900 }
  );
  const reservation = await Call.findOneAndUpdate({
    _id: c.id, recordingStatus: { $ne: "uploaded" },
    $or: [{ recordingStatus: { $ne: "uploading" } }, { recordingBytes: bytes,
      recordingContentType: { $in: [null, contentType] } }],
  }, { $set: { recordingKey: key, recordingBytes: bytes, recordingContentType: contentType,
    recordingStatus: "uploading" } }, { new: true });
  if (!reservation) {
    if (await Call.exists({ _id: c.id, recordingStatus: "uploaded" })) return alreadyUploaded();
    throw Object.assign(Error("A different recording is already queued for this call"), { status: 409 });
  }
  return {
    url: signed,
    contentType,
    headers: {
      "Content-Type": contentType,
      "x-amz-server-side-encryption": "AES256",
      "If-None-Match": "*",
    },
  };
}
export async function completeUpload(c) {
  if (c.recordingStatus === "uploaded" && await Job.exists({ key: `ai:${c.id}` })) return c;
  if (!c.recordingKey) throw Error("Start upload first");
  const h = await s3.send(new HeadObjectCommand({ Bucket: bucket(), Key: c.recordingKey }));
  if (h.ContentLength !== c.recordingBytes ||
      (c.recordingContentType && h.ContentType !== c.recordingContentType))
    throw Error("Uploaded recording does not match the reserved size or format");
  const session = await mongoose.startSession();
  let saved;
  try {
    await session.withTransaction(async () => {
      saved = await Call.findById(c.id).session(session);
      if (!saved || saved.recordingKey !== c.recordingKey || saved.recordingBytes !== c.recordingBytes)
        throw Object.assign(Error("Recording reservation changed"), { status: 409 });
      if (saved.recordingStatus !== "uploaded") {
        saved.recordingStatus = "uploaded";
        saved.aiStatus = "queued";
        await saved.save({ session });
      }
      await Job.updateOne({ key: `ai:${c.id}` },
        { $setOnInsert: { call: c.id, status: "pending", nextAt: new Date() } }, { upsert: true, session });
    });
  } finally { await session.endSession(); }
  return saved;
}
export async function playback(c) {
  if (c.recordingStatus !== "uploaded") throw Error("No uploaded recording");
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket(), Key: c.recordingKey }),
    { expiresIn: 300 }
  );
}
