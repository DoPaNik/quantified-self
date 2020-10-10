import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { EventInterface } from '@sports-alliance/sports-lib/lib/events/event.interface';
import { User } from '@sports-alliance/sports-lib/lib/users/user';

@Component({
  selector: 'app-activities-toggles',
  templateUrl: './activities-toggles.component.html',
  styleUrls: ['./activities-toggles.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush, // @todo not sure
})

export class ActivitiesTogglesComponent {
  @Input() isOwner?: boolean;
  @Input() event: EventInterface;
  @Input() user?: User;

  constructor() {
  }
}
