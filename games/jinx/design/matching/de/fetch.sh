#!/bin/sh
# Download the raw data for the German lexicon into ../../words/raw/de/
# (git-ignored; see SPEC.md §2). build-lexicon.ts reads it.
set -eu
cd "$(dirname "$0")/../../words"
mkdir -p raw/de
cd raw/de
get() { [ -s "$1" ] || curl -fsSL -o "$1" "$2"; }

# German Wiktionary, extracted by wiktextract (kaikki.org): CC BY-SA 4.0 (and GFDL).
get raw-wiktextract-data.jsonl.gz https://kaikki.org/dewiktionary/raw-wiktextract-data.jsonl.gz
# Word frequencies from OpenSubtitles 2018 (Hermit Dave's FrequencyWords, content CC BY-SA 4.0):
# only used to choose which lemmas go in; no counts are shipped.
get de_full.txt https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/de/de_full.txt
echo "raw data ready"
