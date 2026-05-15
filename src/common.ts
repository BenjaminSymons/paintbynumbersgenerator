
export type RGB = number[];

export interface IMap<T> {
    [key: string]: T;
}

export async function delay(ms: number): Promise<void> {
    if (typeof window !== "undefined") {
        return new Promise<void>((resolve) => (window as any).setTimeout(resolve, ms));
    } else {
        return Promise.resolve();
    }
}

export class CancellationToken {
    public isCancelled: boolean = false;
}
