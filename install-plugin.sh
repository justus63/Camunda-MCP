#!/bin/bash
# Installiert das Live-Plugin in den Camunda Modeler (macOS).
# Danach den Modeler komplett beenden und neu starten.
set -e
DEST="$HOME/Library/Application Support/camunda-modeler/resources/plugins/bpmn-mcp-bridge"
SRC="$(cd "$(dirname "$0")" && pwd)/plugin"
mkdir -p "$DEST"
cp "$SRC/index.js" "$SRC/client.js" "$DEST/"
echo "Plugin installiert in: $DEST"
echo "Jetzt Camunda Modeler neu starten."
