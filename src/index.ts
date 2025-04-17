import { tmpdir } from "node:os";
import { getInput, setOutput, setFailed, getBooleanInput } from "@actions/core";
import runAction from "./action";

if (!process.env.RUNNER_TEMP) {
  process.env.RUNNER_TEMP = tmpdir();
}

runAction({
  version: getInput("version") || undefined,
  os: getInput("os") || undefined,
  arch: getInput("arch") || undefined,
  noCache: getBooleanInput("no-cache") || false,
})
  .then(({ version, cacheHit }) => {
    setOutput("gitops-cli-version", version);
    setOutput("cache-hit", cacheHit);
    process.exit(0);
  })
  .catch((error) => {
    setFailed(error);
    process.exit(1);
  });
