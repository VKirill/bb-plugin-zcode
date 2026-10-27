import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// What a host reports about ZCode on its machine (the host entry runs on the machine that has the ZCode app).
export const hostStatus = z.object({
  platform: z.string(),
  appFound: z.boolean(),
  appPath: z.string().nullable(),
  bridgeFound: z.boolean(),
  bridgeVersion: z.string().nullable(),
  agentFound: z.boolean(),
  zcaxFound: z.boolean(),
  running: z.boolean().nullable(),
  signedIn: z.boolean().nullable(),
  sessionExpired: z.boolean().nullable(),
  accessibility: z.boolean().nullable(),
  defaultModel: z.string().nullable(),
  models: z.array(z.object({ name: z.string(), enabled: z.boolean() })),
  route: z.string().nullable(),
  rewards: z
    .object({
      status: z.string().nullable(),
      atUtc: z.string().nullable(),
      claimedDay: z.string().nullable(),
      bannerSeen: z.boolean().nullable(),
    })
    .nullable(),
  quota: z.record(z.string(), z.object({ remaining: z.string().optional(), resets: z.string().optional() })).nullable(),
  problems: z.array(z.string()),
});
export type HostStatus = z.infer<typeof hostStatus>;

export const hostContract = defineRpcContract({
  status: { input: z.object({}).strict(), output: hostStatus, experimental_retryable: true },
  refreshModels: { input: z.object({}).strict(), output: hostStatus },
  readQuota: { input: z.object({}).strict(), output: hostStatus },
});

export const hostEntry = z.object({ hostId: z.string(), name: z.string(), connected: z.boolean(), status: hostStatus.nullable(), error: z.string().nullable() });
export type HostEntry = z.infer<typeof hostEntry>;

// What the settings page asks the server.
export const rpcContract = defineRpcContract({
  hosts: { input: z.object({ refresh: z.enum(["none", "models", "quota"]).optional(), hostId: z.string().optional() }).strict(), output: z.object({ hosts: z.array(hostEntry) }) },
});
