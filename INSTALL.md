# SAP ADT Hub: Setup

1. Install **Node.js LTS** from https://nodejs.org (Next, Next, Finish). Skip this if you already have it.
2. Download **sap-adt-hub.mcpb** from the latest release and **double-click** it. Claude opens, then click **Install** and **Save**.
   All settings are optional.
3. In a new Claude chat, send:

   > Connect to my SAP system DEV at https://myhost:44300, client 100, user JDOE.

   A Windows window asks for your SAP password. Type it there, never in the chat.

Done. Ask things like *"Show me the source of report ZMY_REPORT in DEV"* or *"Compare class ZCL_X between DEV and QAS"*.

Claude can only read until you say otherwise. To let it change code, tell it, e.g. *"allow writes in DEV for package $TMP"*.
