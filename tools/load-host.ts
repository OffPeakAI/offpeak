#!/usr/bin/env bun
import { keccak256, toBytes } from "viem"
import { createHostApp } from "../apps/host-agent/src/mock-engine.ts"
import { addressOf } from "../packages/abis/src/index.ts"
import { roleAccount } from "../packages/shared/src/test-keys.ts"

/** The mock host in its own process, so load numbers measure the router and not the host. */
const { app } = createHostApp({
  operator: roleAccount("host") as never,
  routerAddress: roleAccount("router").address,
  usageLedger: addressOf("UsageLedger"),
  modelDigest: keccak256(toBytes("ofm-8b")),
  modelName: "ofm-8b",
  imageDigest: keccak256(toBytes("offpeak-image-v1")),
  gpuClass: "h100-80g-sxm",
  swap: false,
  sealed: false,
})
Bun.serve({ port: Number(process.env.OFFPEAK_HOST_PORT ?? 29790), fetch: app.fetch })
console.log("ready")
