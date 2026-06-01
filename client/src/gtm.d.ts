// src/types/gtm.d.ts

interface GtmEventData {
  [key: string]: any;
}

declare global {
  interface Window {
    gtmPush?: (event: string, data?: GtmEventData) => void;
    dataLayer?: any[];
  }

  function gtmPush(event: string, data?: GtmEventData): void;
}

export {};
