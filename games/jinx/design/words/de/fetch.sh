#!/bin/sh
# Download the raw data for the German list into ../raw/de/ (git-ignored; see README.md).
set -eu
cd "$(dirname "$0")"
mkdir -p ../raw/de
cd ../raw/de
get() { [ -s "$1" ] || curl -fsSL -o "$1" "$2"; }

LO=https://raw.githubusercontent.com/LibreOffice/dictionaries/master/de
# igerman98 / "frami" Hunspell dictionaries (Björn Jacke et al.): GPLv2, GPLv3 or OASIS
for v in de_DE de_AT de_CH; do
  get ${v}_frami.dic $LO/${v}_frami.dic
  get ${v}_frami.aff $LO/${v}_frami.aff
done
get README_de_DE_frami.txt $LO/README_de_DE_frami.txt
# Subtitle word frequencies (Hermit Dave, from OpenSubtitles 2018; CC BY-SA 4.0): only for review reports, nothing shipped
get de_50k.txt https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/de/de_50k.txt
echo "raw data ready"
