#!/bin/sh
# Test helper: makes Office files with the bundled Python and converts them with the bundled engine.
root=$1 work=$2
res="$root/current/resources"; py="$res/runtime/primary-runtime/dependencies/python/bin/python3"
cli="$res/app.asar/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js"
rm -rf "$work"; mkdir -p "$work"
"$py" -I "$(dirname -- "$0")/make-office.py" "$work" || exit 1
ELECTRON_RUN_AS_NODE=1 "$root/current/deepseek-harness" "$cli" capabilities --json | cut -c1-400; echo
for f in a.docx b.xlsx c.pptx; do
  start=$(date +%s.%N)
  ELECTRON_RUN_AS_NODE=1 timeout 170 "$root/current/deepseek-harness" "$cli" render --input "$work/$f" --output-dir "$work/out-$f" | cut -c1-260; echo
  echo "$f exit=$? seconds=$(echo "$(date +%s.%N) - $start" | bc | cut -c1-5) files: $(ls "$work/out-$f" 2>/dev/null | tr '\n' ' ')"
  file "$work/out-$f"/*.pdf 2>/dev/null | sed 's#.*/##' | cut -c1-80
done
