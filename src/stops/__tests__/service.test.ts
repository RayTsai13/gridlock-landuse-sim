import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { configureTrainService, synthesizeTrainInstances } from '../trains.ts';
import { DEPLOY_STEPS } from '../data.ts';
import type { TrainServiceArtifact } from '../train_service.ts';

const artifact: TrainServiceArtifact = JSON.parse(readFileSync('public/seattle/train-service.json', 'utf8'));

it('uses shared JSON schedules with matching track geometry', () => {
  configureTrainService(artifact);
  for (const step of DEPLOY_STEPS) {
    expect(step.line.path).toEqual(artifact.paths[step.line.id]);
    const profiles = artifact.lineProfiles.filter((profile) => profile.lineId === step.line.id);
    expect(profiles).toHaveLength(3);
    for (const profile of profiles) {
      for (const direction of profile.directionProfiles) {
        expect(direction.pathCumulativeMeters.length).toBe(step.line.path?.length);
        expect(direction.stopIds).toEqual(direction.directionId === 0 ? step.line.stopIds : [...step.line.stopIds].reverse());
      }
    }
  }
  const trains = synthesizeTrainInstances(DEPLOY_STEPS.map((step) => step.line), 2 * 1440 + 480);
  expect(trains.length).toBeGreaterThan(0);
  expect(trains.every((train) => train.coordinates.every(Number.isFinite))).toBe(true);
});

it('rejects unsupported service artifacts', () => {
  expect(() => configureTrainService({ ...artifact, version: 999 })).toThrow('Invalid train-service artifact');
});
