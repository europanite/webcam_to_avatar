declare module "three/examples/jsm/loaders/GLTFLoader" {
  import * as THREE from "three";

  export class GLTFLoader extends THREE.Loader {
    constructor();

    /**
     * Register a GLTF parser plugin (used by @pixiv/three-vrm's VRMLoaderPlugin).
     */
    register(callback: (parser: any) => any): this;

    load(
      url: string,
      onLoad: (gltf: any) => void,
      onProgress?: (event: ProgressEvent<EventTarget>) => void,
      onError?: (event: unknown) => void
    ): void;
  }
}
