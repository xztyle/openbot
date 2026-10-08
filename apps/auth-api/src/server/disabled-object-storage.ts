import { Schema } from "effect";

export class ObjectStorageDisabledError extends Schema.TaggedError<ObjectStorageDisabledError>()(
  "ObjectStorageDisabledError",
  {},
) {}

function refuseWrite(): Promise<never> {
  return Promise.reject(new ObjectStorageDisabledError({}));
}

// A private deployment can omit paid object-storage bindings. Reads stay empty and
// writes fail before any external request or metadata commit can succeed.
export const disabledObjectStorage: R2Bucket = {
  head: () => Promise.resolve(null),
  get: () => Promise.resolve(null),
  put: refuseWrite,
  delete: () => Promise.resolve(),
  list: () => Promise.resolve({ objects: [], truncated: false, delimitedPrefixes: [] }),
  createMultipartUpload: refuseWrite,
  resumeMultipartUpload: () => {
    throw new ObjectStorageDisabledError({});
  },
};
