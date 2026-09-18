# VOID Prime TokenRouter Configuration Fix

## Problem
The control-plane test "Prime TokenRouter import keeps the free default model when available" was failing.

## Root Cause
Prime TokenRouter configuration in `.prime/agent/models.json` was overriding the free default model availability, breaking the expected behavior.

## Solution
1. Fixed Prime TokenRouter configuration to preserve free default model
2. Added `free: true` to TokenRouter entries
3. Ensured proper fallback behavior

## Changes Made
- Updated `.prime/agent/models.json` with correct Prime TokenRouter configuration
- Ensured free default model availability is preserved
- Maintained backward compatibility

## Verification
- All existing tests now pass
- Free default model behavior preserved
- Prime TokenRouter properly configured

## Author
Dawe583

## Date
2026-09-18
