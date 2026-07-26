export type Log = {
     timestamp: Date;
     level: "debug" | "info" | "warn" | "error";
     service: string;
     message: string;
     attributes: object
};