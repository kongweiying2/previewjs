import type { GetPropsFn, RendererLoader } from "@previewjs/iframe";
import type { App } from "vue";
import { createApp } from "vue";

const root = document.getElementById("root")!;
let app: App | null = null;

export const load: RendererLoader = async ({
  wrapperModule,
  wrapperName,
  componentModule,
  componentId,
  shouldAbortRender,
}) => {
  const componentName = componentId.substring(componentId.indexOf(":") + 1);
  const isStoryModule = !!componentModule.default?.component;
  const Wrapper =
    (wrapperModule && wrapperModule[wrapperName || "default"]) || null;
  let ComponentOrStory: any;
  if (componentId.includes(".vue:")) {
    ComponentOrStory = componentModule.default;
    if (!ComponentOrStory) {
      throw new Error(`No default component could be found for ${componentId}`);
    }
  } else {
    ComponentOrStory = componentModule[`__previewjs__${componentName}`];
    if (!ComponentOrStory) {
      throw new Error(`No component named '${componentName}'`);
    }
  }
  let storyDecorators = ComponentOrStory.decorators || [];
  let RenderComponent = ComponentOrStory;
  if (ComponentOrStory.render && !isStoryModule) {
    // Vue component. Nothing to do.
  } else {
    // JSX or Storybook story, either CSF2 or CSF3.
    if (typeof ComponentOrStory === "function") {
      RenderComponent = (props: any) => {
        const storyReturnValue = ComponentOrStory(props);
        if (storyReturnValue.template) {
          // CSF2 story.
          // @ts-ignore
          return h(storyReturnValue, props);
        } else {
          // JSX
          return storyReturnValue;
        }
      };
    } else {
      // CSF3 story.
      const csf3Story = ComponentOrStory;
      RenderComponent =
        csf3Story.component || componentModule.default?.component;
      if (!RenderComponent) {
        throw new Error("Encountered a story with no component");
      }
    }
  }
  const decorators = [
    ...storyDecorators,
    ...(componentModule.default?.decorators || []),
  ];
  const Decorated = decorators.reduce((component, decorator) => {
    const decorated = decorator();
    return {
      ...decorated,
      components: { ...decorated.components, story: component },
    };
  }, RenderComponent);
  return {
    render: async (getProps: GetPropsFn) => {
      if (shouldAbortRender()) {
        return;
      }
      if (app) {
        app.unmount();
        app = null;
      }
      const props = getProps({
        presetGlobalProps: componentModule.default?.args || {},
        presetProps: ComponentOrStory.args || {},
      });
      app = createApp(() => {
        // @ts-ignore
        const decoratedNode = slotTransformingH(Decorated, props);
        return Wrapper
          ? // @ts-ignore
            h(Wrapper, null, () => decoratedNode)
          : decoratedNode;
      }, {});
      app.mount(root);
      if (ComponentOrStory.play) {
        try {
          await ComponentOrStory.play({ canvasElement: root });
        } catch (e: any) {
          // For some reason, Storybook expects to throw exceptions that should be ignored.
          if (!e.message?.startsWith("ignoredException")) {
            throw e;
          }
        }
      }
    },
    // @ts-ignore
    jsxFactory: slotTransformingH,
  };
};

function slotTransformingH(component: any, props: any, children: any) {
  props ||= {};
  // @ts-ignore
  return h(
    component,
    Object.fromEntries(
      Object.entries(props).filter(
        ([propName]) => !propName.startsWith("slot:")
      )
    ),
    children !== undefined
      ? children
      : Object.fromEntries(
          Object.entries(props)
            .filter(([propName]) => propName.startsWith("slot:"))
            .map(([propName, propValue]) => [
              propName.substring(5),
              () => propValue,
            ])
        )
  );
}
