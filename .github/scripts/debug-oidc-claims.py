#!/usr/bin/env python3
"""Print the OIDC identity claims GitHub is presenting to AWS.

Called by .github/workflows/build-and-deploy.yml when the repository variable
DEBUG_OIDC is "true". Use it when the credentials step fails with
"Not authorized to perform sts:AssumeRoleWithWebIdentity": the "sub" claim
printed here is what the role's trust policy has to accept.

Only the decoded claims are printed - never the token itself, and nothing is
written to disk.
"""

import base64
import json
import os
import sys
import urllib.request

INTERESTING = ("sub", "aud", "repository", "repository_owner",
               "repository_owner_id", "repository_id", "ref")


def main():
    url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL")
    secret = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not url or not secret:
        print("::error::No OIDC token endpoint in the environment - the job needs "
              "'permissions: id-token: write'.")
        return 1

    request = urllib.request.Request(
        url + "&audience=sts.amazonaws.com",
        headers={"Authorization": "bearer " + secret})
    with urllib.request.urlopen(request) as response:
        token = json.load(response)["value"]

    payload = token.split(".")[1]  # header.payload.signature, base64url, unpadded
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))

    print("Claims GitHub is presenting to AWS:")
    for key in INTERESTING:
        if key in claims:
            print("  %-20s = %s" % (key, claims[key]))
    print()
    print('  The role trust policy must accept the "sub" value above.')
    return 0


if __name__ == "__main__":
    sys.exit(main())
