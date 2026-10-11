export const identityE2eTools = [
  {
    name: "aws.s3.object.put",
    description: "Overwrite the demo bucket object",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, body: { type: "string" } },
      required: ["key", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "aws.s3.bucket.delete",
    description: "Delete the demo bucket after operator approval",
    inputSchema: {
      type: "object",
      properties: { bucket: { type: "string" } },
      required: ["bucket"],
      additionalProperties: false,
    },
  },
  {
    name: "aws.s3.object.delete",
    description: "Delete a demo object for the policy denial case",
    inputSchema: {
      type: "object",
      properties: { bucket: { type: "string" }, key: { type: "string" } },
      required: ["bucket", "key"],
      additionalProperties: false,
    },
  },
];
