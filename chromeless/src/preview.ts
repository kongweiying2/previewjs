import type { Workspace } from "@previewjs/core";
import {
  generateCallbackProps,
  generatePropsAssignmentSource,
} from "@previewjs/properties";
import type playwright from "playwright";
import ts from "typescript";
import { setupPreviewEventListener } from "./event-listener";
import { getPreviewIframe } from "./iframe";

export async function startPreview({
  workspace,
  page,
  port,
}: {
  workspace: Workspace;
  page: playwright.Page;
  port?: number;
}) {
  const preview = await workspace.preview.start(
    port ? async () => port : undefined
  );
  await page.goto(preview.url());

  // This callback will be invoked each time a component is done rendering.
  let onRenderingDone = () => {
    // No-op by default.
  };
  let onRenderingError = (_e: any) => {
    // No-op by default.
  };
  let renderSucceeded = false;
  let lastErrorLog: string | null = null;
  let delay: NodeJS.Timeout;

  function errorUnlessSoonSuccessful(message: string) {
    delay = setTimeout(() => {
      onRenderingError(new Error(message));
    }, 5000);
  }

  const events = await setupPreviewEventListener(page, (event) => {
    if (event.kind === "rendering-done") {
      if (event.success) {
        renderSucceeded = true;
        clearTimeout(delay);
        onRenderingDone();
      } else {
        if (lastErrorLog) {
          errorUnlessSoonSuccessful(lastErrorLog);
        } else {
          // The error log should be coming straight after.
        }
      }
    } else if (event.kind === "log-message" && event.level === "error") {
      lastErrorLog = event.message;
      if (!renderSucceeded) {
        errorUnlessSoonSuccessful(event.message);
      }
    }
  });

  return {
    events,
    iframe: {
      async waitForIdle() {
        await waitUntilNetworkIdle(page);
      },
      async waitForSelector(
        selector: string,
        options: {
          state?: "attached" | "detached" | "visible" | "hidden";
        } = {}
      ) {
        const iframe = await getPreviewIframe(page);
        const element = await iframe.waitForSelector(selector, options);
        return element!;
      },
      async takeScreenshot(destinationPath: string) {
        const preview = await getPreviewIframe(page);
        preview.addStyleTag({
          content: `
*,
*::after,
*::before {
  transition-delay: 0s !important;
  transition-duration: 0s !important;
  animation-delay: -0.0001s !important;
  animation-duration: 0s !important;
  animation-play-state: paused !important;
  caret-color: transparent !important;
  color-adjust: exact !important;
}
`,
        });
        // Ensure all images are loaded.
        // Source: https://stackoverflow.com/a/49233383
        await preview.evaluate(async () => {
          const selectors = Array.from(document.querySelectorAll("img"));
          await Promise.all(
            selectors.map((img) => {
              if (img.complete) {
                return;
              }
              return new Promise<unknown>((resolve) => {
                const observer = new IntersectionObserver((entries) => {
                  if (entries[0]?.isIntersecting) {
                    img.addEventListener("load", resolve);
                    // If an image fails to load, ignore it.
                    img.addEventListener("error", resolve);
                  } else {
                    resolve(null);
                  }
                  observer.unobserve(img);
                });
                observer.observe(img);
              });
            })
          );
        });
        await page.screenshot({
          path: destinationPath,
        });
      },
    },
    async show(componentId: string, propsAssignmentSource?: string) {
      const filePath = componentId.split(":")[0]!;
      const { components, stories } = await workspace.detectComponents({
        filePaths: [filePath],
      });
      const matchingDetectedComponent = components.find(
        (c) => componentId === c.componentId
      );
      const matchingDetectedStory = stories.find(
        (c) => componentId === c.componentId
      );
      if (!matchingDetectedComponent && !matchingDetectedStory) {
        throw new Error(
          `Component may be previewable but was not detected by framework plugin: ${componentId}`
        );
      }
      const computePropsResponse = await workspace.computeProps({
        componentIds: [componentId],
      });
      const props = computePropsResponse.props[componentId]!;
      const autogenCallbackProps = await generateCallbackProps(
        props,
        computePropsResponse.types
      );
      if (!propsAssignmentSource) {
        propsAssignmentSource = matchingDetectedStory
          ? "properties = null"
          : await generatePropsAssignmentSource(
              props,
              autogenCallbackProps.keys,
              computePropsResponse.types
            );
      }
      const donePromise = new Promise<void>((resolve, reject) => {
        onRenderingDone = resolve;
        onRenderingError = reject;
      });
      await waitUntilNetworkIdle(page);
      renderSucceeded = false;
      await page.evaluate(
        async (component) => {
          // It's possible that window.renderComponent isn't ready yet.
          let waitStart = Date.now();
          const timeoutSeconds = 10;
          while (
            !window.renderComponent &&
            Date.now() - waitStart < timeoutSeconds * 1000
          ) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (!window.renderComponent) {
            throw new Error(
              `window.renderComponent() isn't available after waiting ${timeoutSeconds} seconds`
            );
          }
          window.renderComponent(component);
        },
        {
          componentId,
          autogenCallbackPropsSource: transpile(
            `autogenCallbackProps = ${autogenCallbackProps.source}`
          ),
          propsAssignmentSource: transpile(propsAssignmentSource!),
        }
      );
      await donePromise;
      await waitUntilNetworkIdle(page);
    },
    async stop() {
      await preview.stop();
      await workspace.dispose();
    },
  };
}

function transpile(source: string) {
  // Transform JSX if required.
  try {
    return ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
        jsxFactory: "__jsxFactory__",
      },
    }).outputText;
  } catch (e) {
    throw new Error(`Error transforming source:\n${source}\n\n${e}`);
  }
}

async function waitUntilNetworkIdle(page: playwright.Page) {
  await page.waitForLoadState("networkidle");
  try {
    await (await getPreviewIframe(page)).waitForLoadState("networkidle");
  } catch (e) {
    // It's OK for the iframe to be replaced by another one, in which case wait again.
    await (await getPreviewIframe(page)).waitForLoadState("networkidle");
  }
}
