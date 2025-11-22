declare module "three/examples/jsm/loaders/GLTFLoader" {
  import * as THREE from "three";

  export class GLTFLoader extends THREE.Loader {
    constructor();

    load(
      url: string,
      onLoad: (gltf: any) => void,
      onProgress?: (event: ProgressEvent<EventTarget>) => void,
      onError?: (event: unknown) => void
    ): void;
  }
}
