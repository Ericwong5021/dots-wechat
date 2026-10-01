# Third-party notices

Dependencies are exact-version locked by package-lock.json, installed from registry.npmjs.org with lifecycle scripts disabled. No third-party implementation source is vendored in this directory; node_modules remains ignored. The licenses/ directory contains byte-for-byte copies of the actual installed dependency license files, with package/version/hash provenance in licenses-manifest.json.

The official MCP packages are server/client/core 2.2.0 and Node adapter 2.1.0. Their npm metadata declares MIT, but their actual packaged LICENSE states a transition to Apache-2.0 with original MIT contributions retained under their original license. The original project MIT grant does not override this mixed provenance. Preserve the entire packaged LICENSE, not just the npm metadata field.

Other transitive dependencies retain their packaged MIT or ISC licenses. The lockfile, license manifest and copied notices identify the exact installed versions. No user image, commercial firmware SDK, existing bot credentials or private account configuration is part of this service deliverable.

The QR renderer is qrcode 1.5.4, with its exact transitive dependencies pinned in package-lock.json. Actual license copies for all 46 installed dependency packages are included. The Tencent openclaw-weixin protocol reference at revision 24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c retains its original MIT copyright and full notice separately; its implementation is not vendored.
