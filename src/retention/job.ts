import * as cron from "node-cron";
import { Env } from "../config.js";
import { dropOldPartitions, ensureFuturePartitions, reconcileDefaultPartition } from "./partitions.js";

export function retentionJob(): void {
    // i use 00:10 every day to be sure that we are (for device/node time, and the schdule ones) in the same new day
    cron.schedule(Env.RETENTION_CRON, () => {
        retain();
    })
}

export async function retain(): Promise<void> {
    const created = await ensureFuturePartitions(Env.PARTITION_LOOKAHEAD_DAYS)
    const dropped = await dropOldPartitions(Env.RETENTION_DAYS);
    const reconciled = await reconcileDefaultPartition(Env.RETENTION_DAYS);
    console.log("created new partitions")
    console.dir(created.join('\n'), { colors: true })
    console.log("=====================\n\ndropped by retention")
    console.dir(dropped.join('\n'), { colors: true })
    console.log("=====================\n\nreconciled logs_default")
    console.dir(reconciled, { colors: true })
}