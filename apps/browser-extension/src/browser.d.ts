declare const chrome: {
  action: { onClicked: { addListener(fn: () => void): void } };
  runtime: { getURL(path: string): string };
  tabs: {
    query(query: {
      active?: boolean;
      currentWindow?: boolean;
      url?: string;
    }): Promise<Array<{ id?: number; url?: string }>>;
    create(options: { url: string }): Promise<{ id?: number; url?: string }>;
    getCurrent(): Promise<{ id?: number; url?: string } | undefined>;
    update(id: number, options: { active: boolean }): Promise<unknown>;
    remove(id: number): Promise<void>;
    onUpdated: {
      addListener(
        fn: (
          id: number,
          change: { url?: string; status?: string },
          tab: { id?: number; url?: string },
        ) => void,
      ): void;
      removeListener(
        fn: (
          id: number,
          change: { url?: string; status?: string },
          tab: { id?: number; url?: string },
        ) => void,
      ): void;
    };
    onRemoved: {
      addListener(fn: (id: number) => void): void;
      removeListener(fn: (id: number) => void): void;
    };
  };
  permissions: {
    request(permission: { origins: string[] }): Promise<boolean>;
    contains(permission: { origins: string[] }): Promise<boolean>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(value: Record<string, unknown>): Promise<void>;
    };
  };
  scripting: {
    executeScript<T>(options: {
      target: { tabId: number };
      world: "MAIN";
      func: () => T;
    }): Promise<Array<{ result?: T }>>;
  };
};
