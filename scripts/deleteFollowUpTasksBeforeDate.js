/**
 * Delete follow-up call tasks created before a cutoff date (default: 24 Sep 2026 IST).
 *
 * Usage (from backend/):
 *   node scripts/deleteFollowUpTasksBeforeDate.js              # dry run
 *   node scripts/deleteFollowUpTasksBeforeDate.js --execute    # delete
 */
import mongoose from 'mongoose';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { connectDb } from '../src/config/db.js';
import { Task } from '../src/models/task.model.js';
import { Notification } from '../src/models/notification.model.js';
import { TASK_TYPE } from '../src/constants/crm.constants.js';
import { recomputeLeadNextAction } from '../src/services/leadWorkflow.service.js';
import { APP_TIMEZONE } from '../src/utils/time.js';

dayjs.extend(utc);
dayjs.extend(timezone);

function parseArgs(argv) {
  let before = '2026-09-24';
  let execute = false;
  for (const arg of argv) {
    if (arg.startsWith('--before=')) before = arg.slice('--before='.length);
    if (arg === '--execute') execute = true;
  }
  return { before, execute };
}

const { before, execute } = parseArgs(process.argv.slice(2));
const cutoff = dayjs.tz(before, APP_TIMEZONE).startOf('day').toDate();

const filter = {
  type: TASK_TYPE.FOLLOW_UP_CALL,
  createdAt: { $lt: cutoff },
};

await connectDb();

const tasks = await Task.find(filter).select('_id leadId status title createdAt').lean();
const taskIds = tasks.map((t) => t._id);
const leadIds = [...new Set(tasks.map((t) => t.leadId?.toString()).filter(Boolean))];

console.log(`Cutoff: task createdAt < ${before} 00:00:00 ${APP_TIMEZONE} (${cutoff.toISOString()})`);
console.log(`Type: ${TASK_TYPE.FOLLOW_UP_CALL}`);
console.log(`Matched: ${tasks.length} task(s), ${leadIds.length} lead(s) affected`);

if (!tasks.length) {
  await mongoose.connection.close();
  process.exit(0);
}

const byStatus = tasks.reduce((acc, t) => {
  acc[t.status] = (acc[t.status] || 0) + 1;
  return acc;
}, {});
console.log('By status:', byStatus);

if (!execute) {
  console.log('\nDry run only. Pass --execute to delete these tasks and related notifications.');
  await mongoose.connection.close();
  process.exit(0);
}

const notifResult = await Notification.deleteMany({ taskId: { $in: taskIds } });
const taskResult = await Task.deleteMany({ _id: { $in: taskIds } });

console.log(`Deleted notifications: ${notifResult.deletedCount}`);
console.log(`Deleted tasks: ${taskResult.deletedCount}`);

let recomputed = 0;
for (const leadId of leadIds) {
  await recomputeLeadNextAction(leadId);
  recomputed += 1;
}
console.log(`Recomputed next action for ${recomputed} lead(s)`);

await mongoose.connection.close();
process.exit(0);
