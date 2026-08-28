#!/usr/bin/env bash
#
# Validate the repository configuration the deploy workflow depends on, against
# the same rules AWS enforces. Called by .github/workflows/build-and-deploy.yml.
#
# A malformed value otherwise surfaces many steps later as an opaque AWS error
# that looks like a network or permissions problem rather than a typo - a
# truncated AWS_REGION, for example, becomes
# "getaddrinfo ENOTFOUND sts.<region>.amazonaws.com".
#
# Reads:   AWS_REGION, ECR_REPOSITORY (repository variables)
#          ROLE_ARN                   (the AWS_ROLE_ARN secret)
# Writes:  cleaned AWS_REGION / ECR_REPOSITORY back to $GITHUB_ENV
# Exits:   0 when the configuration is usable, 1 with ::error:: annotations otherwise
#
# Runnable locally:
#   AWS_REGION=eu-central-1 ECR_REPOSITORY=week6-todo \
#   ROLE_ARN=arn:aws:iam::123456789012:role/x bash .github/scripts/verify-config.sh

# Deliberately no -e: collect every problem in one run instead of stopping at
# the first, so a misconfigured repository is fixed in one pass.
set -uo pipefail

GITHUB_ENV="${GITHUB_ENV:-/dev/null}"
AWS_REGION="${AWS_REGION:-}"
ECR_REPOSITORY="${ECR_REPOSITORY:-}"
ROLE_ARN="${ROLE_ARN:-}"

RC=0
problem() { echo "::error::$*"; RC=1; }

# ---- normalise copy-paste artifacts, keep the cleaned value ------------------
# Values pasted out of documentation routinely arrive wrapped in markdown
# backticks or quotes, or with a stray space or CR. Strip those rather than
# failing on them, and say so.
for v in AWS_REGION ECR_REPOSITORY; do
  raw="$(eval printf '%s' "\"\${$v}\"")"
  clean="$raw"
  # repeat: handles `"value"` and similar nestings
  for _ in 1 2 3; do
    clean="$(printf '%s' "$clean" | tr -d '\r' \
      | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
            -e 's/^[`"'"'"']*//'  -e 's/[`"'"'"']*$//')"
  done
  [ "$raw" = "$clean" ] || echo "::warning::${v} contained stray characters (whitespace, backticks or quotes) - using '${clean}'."
  printf '%s=%s\n' "$v" "$clean" >> "$GITHUB_ENV"
  eval "$v=\$clean"
done

# ---- AWS_ROLE_ARN: a secret, masked in logs, so report shape only -----------
case "${ROLE_ARN}" in
  "")                    problem "AWS_ROLE_ARN secret is not set. Set it to the GitHubActionsRoleArn stack output." ;;
  arn:aws:iam::*:role/*) ;;
  *)                     problem "AWS_ROLE_ARN is set but is not an IAM role ARN (expected arn:aws:iam::<account>:role/<name>)." ;;
esac

# ---- AWS_REGION: e.g. eu-central-1, us-east-1, ap-southeast-2 ---------------
if ! printf '%s' "${AWS_REGION}" | grep -Eq '^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$'; then
  problem "AWS_REGION is '${AWS_REGION}', which is not a valid AWS region (a truncated value such as 'eu-central-' is the usual cause)."
fi

# ---- ECR_REPOSITORY: repository NAME only ----------------------------------
# The registry host is added by amazon-ecr-login, so a full URI here would
# silently build the wrong image name - reject it explicitly.
if printf '%s' "${ECR_REPOSITORY}" | grep -Eq 'amazonaws\.com|^https?://'; then
  problem "ECR_REPOSITORY is '${ECR_REPOSITORY}', which is a full registry URI. Use the repository NAME only - the registry host is added automatically."
elif ! printf '%s' "${ECR_REPOSITORY}" | grep -Eq '^[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$'; then
  problem "ECR_REPOSITORY is '${ECR_REPOSITORY}', which is not a valid ECR repository name (lowercase only)."
fi

[ "$RC" -eq 0 ] || echo "Fix these under: Settings > Secrets and variables > Actions"
exit $RC
