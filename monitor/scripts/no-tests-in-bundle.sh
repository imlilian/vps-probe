#!/bin/sh
# Fails when a module that ships imports a test.
#
# A frontend bundle is built from one entry (`index.html` -> `main.tsx`), so a
# test file reaches the browser only if some module pulls it in -- and then it
# drags assertions, fixtures and Node-only imports into a bundle the hub embeds
# in its binary. Both directions look similar and only one is a mistake: a test
# importing the module it covers is how the suite is written, while a module
# importing a test is always a slip. Run by `make check` and by CI, before
# anything is built.
set -eu

status=0
for src in monitor/web-admin/src monitor/web-site/src; do
	leaks=$(
		grep -rnE "(from|import|require|export)[[:space:]]*\(?[[:space:]]*['\"][^'\"]*\.(test|spec)\.tsx?['\"]" \
			"$src" --include='*.ts' --include='*.tsx' \
			| awk -F: '$1 ~ /\.(test|spec)\.tsx?$/ { next } { print }' \
			| grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|/\*|\*)' || true
	)
	if [ -n "$leaks" ]; then
		printf '%s\n' "$leaks" >&2
		echo "$0: $src has a module importing a test file" >&2
		status=1
	fi
done
exit "$status"
