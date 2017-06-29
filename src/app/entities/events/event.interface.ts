import {ActivityInterface} from 'app/entities/activities/activity.interface';
import {GeodesyAdapterInterface} from '../geodesy/adapters/adapter.interface';
import {PointInterface} from '../points/point.interface';
import {IDClassInterface} from '../id/id.class.interface';
import {SerializableClassInterface} from '../serializable/serializable.class.interface';
import {DataInterface} from "../data/data.interface";
import {LapInterface} from "../laps/lap.interface";
import {Lap} from "../laps/lap";

export interface EventInterface extends IDClassInterface, SerializableClassInterface {
  getGeodesyAdapter(): GeodesyAdapterInterface;
  setName(name: string);
  getName(): string;
  addActivity(activity: ActivityInterface);
  removeActivity(activity: ActivityInterface);
  getActivities(): ActivityInterface[];
  getFirstActivity(): ActivityInterface;
  getLastActivity(): ActivityInterface;
  getLaps(): LapInterface[];
  addLap(lap: Lap);
  getPoints(startDate?: Date, endDate?: Date, step?: number): PointInterface[];
  getPointsWithPosition(startDate?: Date, endDate?: Date, step?: number, activities?: ActivityInterface[]): PointInterface[];
  getData(startDate?: Date, endDate?: Date, step?: number): Map<string, DataInterface[]>;
  getDataByType(dataType: string): DataInterface[];
  getDistanceInMeters(startDate?: Date, endDate?: Date, step?: number): number;
  getTotalDurationInSeconds(): number;
}
