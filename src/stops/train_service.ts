export type TrainDayType = 'weekday' | 'saturday' | 'sunday';

export type TrainServiceWindow = {
  startMinute: number;
  endMinute: number;
  headwayMinutes: number;
  offsetMinutes: number;
};

export type TrainDirectionProfile = {
  directionId: 0 | 1;
  displayStartStopId: string;
  displayEndStopId: string;
  stopIds: string[];
  serviceWindows: TrainServiceWindow[];
  tripRuntimeMinutes: number;
  segmentRuntimeMinutes: number[];
  pathCumulativeMeters: number[];
  stopDistanceMeters: number[];
  synthetic: boolean;
};

export type TrainLineProfile = {
  lineId: string;
  dayType: TrainDayType;
  synthetic: boolean;
  directionProfiles: TrainDirectionProfile[];
};

export type TrainServiceArtifact = {
  version: number;
  paths: Record<string, [number, number][]>;
  metadata: {
    generatedAt: string;
    sourceFeedUrl: string;
    sourceFeedVersion: string;
    sourceFeedStartDate: string;
    sourceFeedEndDate: string;
    defaultDwellSeconds: number;
  };
  lineProfiles: TrainLineProfile[];
};
