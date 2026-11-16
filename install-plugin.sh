#!/bin/bash
# Installs the live plugin into Camunda Modeler (macOS).
# Afterwards quit the Modeler completely and start it again.
set -e
DEST="$HOME/Library/Application Support/camunda-modeler/resources/plugins/bpmn-mcp-bridge"
SRC="$(cd "$(dirname "$0")" && pwd)/plugin"
mkdir -p "$DEST"
cp "$SRC/index.js" "$SRC/client.js" "$DEST/"
echo "Plugin installed to: $DEST"
echo "Now restart Camunda Modeler."
