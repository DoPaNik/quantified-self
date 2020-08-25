import {Component, HostListener} from '@angular/core';
import {AppAuthService} from '../../authentication/app.auth.service';
import {Router} from '@angular/router';
import { ServiceNames } from '@sports-alliance/sports-lib/lib/meta-data/event-meta-data.interface';


@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.css'],
})
export class HomeComponent {

  public serviceNames = ServiceNames

  constructor(public authService: AppAuthService, public router: Router) {

  }

  @HostListener('window:resize', ['$event'])
  getColumnsToDisplayDependingOnScreenSize(event?) {
    return window.innerWidth < 600 ? 1 : 2;
  }
}
