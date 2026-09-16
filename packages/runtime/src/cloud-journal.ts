// Cloud-backed journal using Neon Postgres, matching local journal lifecycle stages.
// This enables atomic capture/dispatch in a single SQL transaction.

import { neon } from "@neondatabase/serverless";
import { createHash } from "crypto";
import type { Stage } from "./journal.ts";

// Neon client using DATABASE_URL
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required for cloud journal");
}
const sql = neon(connectionString);

// === Exported types (must come before any functions with same name) ===

// Cloud-specific operation event type
export type CloudOperationEvent = {
  schema: "void.operation.v1";
  workspace: string;
  operationId: string;
  requestDigest: string;
  adapterId: string;
  adapterVersion: string;
  agentId: string;
  runId: string;
  at: string;
  stage: Stage;
  data: unknown;
};

// Cloud-specific recovery job event type
export type CloudRecoveryJobEvent = {
  schema: "void.recovery-job.v1";
  workspace: string;
  jobId: string;
  planDigest: string;
  at: string;
  stage: Stage;
  data: unknown;
};

// Cloud-specific journal record type
export type CloudJournalRecord = {
  event: CloudOperationEvent | CloudRecoveryJobEvent;
  sequence: number;
  digest: string;
};

// === Cloud journal functions ===

// Initialize cloud journal - creates necessary tables in Neon Postgres
export async function initCloudJournal(): Promise<void> {
  // Create events table for operation journal
  await sql`
    CREATE TABLE IF NOT EXISTS void_cloud_operation_journal (
      id SERIAL PRIMARY KEY,
      workspace VARCHAR(255) NOT NULL,
      operation_id VARCHAR(255) NOT NULL,
      request_digest VARCHAR(255) NOT NULL,
      adapter_id VARCHAR(255) NOT NULL,
      adapter_version VARCHAR(255) NOT NULL,
      agent_id VARCHAR(255) NOT NULL,
      run_id VARCHAR(255) NOT NULL,
      at TIMESTAMP NOT NULL,
      stage VARCHAR(50) NOT NULL,
      data JSONB NOT NULL,
      sequence INTEGER NOT NULL,
      digest VARCHAR(64) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  
  // Create job events table for recovery job journal
  await sql`
    CREATE TABLE IF NOT EXISTS void_cloud_recovery_job_journal (
      id SERIAL PRIMARY KEY,
      workspace VARCHAR(255) NOT NULL,
      job_id VARCHAR(255) NOT NULL,
      plan_digest VARCHAR(255) NOT NULL,
      at TIMESTAMP NOT NULL,
      stage VARCHAR(50) NOT NULL,
      data JSONB NOT NULL,
      sequence INTEGER NOT NULL,
      digest VARCHAR(64) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  
  // Create indexes for performance
  await sql`
    CREATE INDEX IF NOT EXISTS idx_void_cloud_operation_journal_workspace
      ON void_cloud_operation_journal(workspace, operation_id);
  `;
  
  await sql`
    CREATE INDEX IF NOT EXISTS idx_void_cloud_operation_journal_stage
      ON void_cloud_operation_journal(stage);
  `;
  
  await sql`
    CREATE INDEX IF NOT EXISTS idx_void_cloud_recovery_job_journal_workspace
      ON void_cloud_recovery_job_journal(workspace, job_id);
  `;
  
  await sql`
    CREATE INDEX IF NOT EXISTS idx_void_cloud_recovery_job_journal_stage
      ON void_cloud_recovery_job_journal(stage);
  `;
}

// Append an operation event to the cloud journal
export async function appendOperationEvent(
  event: CloudOperationEvent,
  workspace: string
): Promise<CloudJournalRecord> {
  const sequence = await getNextSequence(workspace);
  const digest = createHash('sha256').update(
    JSON.stringify({
      workspace, operationId: event.operationId, sequence, stage: event.stage
    })
  ).digest('hex');
  
  await sql`
    INSERT INTO void_cloud_operation_journal 
      (workspace, operation_id, request_digest, adapter_id, adapter_version, 
       agent_id, run_id, at, stage, data, sequence, digest, created_at)
    VALUES (
      ${workspace}, ${event.operationId}, ${event.requestDigest}, 
      ${event.adapterId}, ${event.adapterVersion}, ${event.agentId}, 
      ${event.runId}, ${event.at}, ${event.stage}, ${JSON.stringify(event.data)}, 
      ${sequence}, ${digest}, CURRENT_TIMESTAMP
    )
  `;
  
  return {
    event,
    sequence,
    digest
  };
}

// Append a recovery job event to the cloud journal
export async function appendJobEvent(
  event: CloudRecoveryJobEvent,
  workspace: string
): Promise<CloudJournalRecord> {
  const sequence = await getNextSequence(workspace);
  const digest = createHash('sha256').update(
    JSON.stringify({
      workspace, jobId: event.jobId, sequence, stage: event.stage
    })
  ).digest('hex');
  
  await sql`
    INSERT INTO void_cloud_recovery_job_journal 
      (workspace, job_id, plan_digest, at, stage, data, sequence, digest, created_at)
    VALUES (
      ${workspace}, ${event.jobId}, ${event.planDigest}, ${event.at}, 
      ${event.stage}, ${JSON.stringify(event.data)}, ${sequence}, ${digest}, 
      CURRENT_TIMESTAMP
    )
  `;
  
  return {
    event,
    sequence,
    digest
  };
}

// Get next sequence number for a workspace (atomic)
async function getNextSequence(workspace: string): Promise<number> {
  const result = await sql`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq
    FROM void_cloud_operation_journal
    WHERE workspace = ${workspace}
  `;
  return (result[0] as any).next_seq;
}

// Get recent records for a workspace
export async function getRecentRecords(workspace: string, limit = 100): Promise<any[]> {
  const opRecords = await sql`
    SELECT event, sequence, digest FROM void_cloud_operation_journal
    WHERE workspace = ${workspace}
    ORDER BY sequence DESC
    LIMIT ${limit}
  `;
  
  const jobRecords = await sql`
    SELECT event, sequence, digest FROM void_cloud_recovery_job_journal
    WHERE workspace = ${workspace}
    ORDER BY sequence DESC
    LIMIT ${limit}
  `;
  
  return [...opRecords, ...jobRecords];
}
