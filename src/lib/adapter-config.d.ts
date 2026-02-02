// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            googleUsername: string;
            googlePassword: string;
            pollInterval: number;
            placesInstance: string;
            fences: Array<{
                name: string;
                latitude: number;
                longitude: number;
                radius: number;
                user: string;
                fenceId: string;
            }>;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};