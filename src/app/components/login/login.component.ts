import { Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import {MatDialog} from '@angular/material/dialog';
import {MatSnackBar} from '@angular/material/snack-bar';
import {Router} from '@angular/router';
import {AppAuthService} from '../../authentication/app.auth.service';
import {User} from '@sports-alliance/sports-lib/lib/users/user';
import {take} from 'rxjs/operators';
import {AppUserService} from '../../services/app.user.service';
import {UserAgreementFormComponent} from '../user-forms/user-agreement.form.component';
import * as Sentry from '@sentry/browser';
import {Log} from 'ng2-logger/browser';
import {AngularFireAuth} from '@angular/fire/auth';
import {ServiceTokenInterface} from '@sports-alliance/sports-lib/lib/service-tokens/service-token.interface';
import {PhoneFormComponent} from './phone-form/phone.form.component';
import {AngularFireAnalytics} from '@angular/fire/analytics';
import { Subscription } from 'rxjs';


@Component({
  selector: 'app-login',
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.css'],
})
export class LoginComponent implements OnInit, OnDestroy {

  isLoading: boolean;
  signInProviders = SignInProviders;


  private userSubscription; Subscription
  private logger = Log.create('LoginComponent');

  @HostListener('window:tokensReceived', ['$event'])
  async tokensReceived(event) {
    this.isLoading = true;
    const loggedInUser = await this.afAuth.signInWithCustomToken(event.detail.firebaseAuthToken);
    this.redirectOrShowDataPrivacyDialog(loggedInUser, event.detail.serviceName, event.detail.serviceAuthResponse);
  }


  constructor(
    public authService: AppAuthService,
    private afAuth: AngularFireAuth,
    private afa: AngularFireAnalytics,
    public userService: AppUserService,
    private router: Router,
    private snackBar: MatSnackBar,
    private dialog: MatDialog,
  ) {
  }

  async ngOnInit() {
    this.userSubscription = this.authService.user.subscribe((user) => {
      if (user) {
        this.router.navigate(['/dashboard']);
        this.snackBar.open(`You are already logged in`, null, {
          duration: 5000,
        });
      }
    })
    this.isLoading = true;
    try {
      const result = await this.afAuth.getRedirectResult();
      if (result.user) {
        await this.redirectOrShowDataPrivacyDialog(result);
      }
    } catch (e) {
      Sentry.captureException(e);
      this.logger.error(e);
      this.snackBar.open(`Could not log in due to ${e}`, null, {
        duration: 2000,
      });
    } finally {
      this.isLoading = false;
    }
  }


  async signInWithProvider(provider: SignInProviders) {
    this.isLoading = true;
    try {
      switch (provider) {
        case SignInProviders.Anonymous:
          await this.redirectOrShowDataPrivacyDialog(await this.authService.anonymousLogin());
          break;
        case SignInProviders.Google:
          await this.authService.googleLoginWithRedirect();
          break;
        case SignInProviders.Facebook:
          await this.authService.facebookLoginWithRedirect();
          break;
        case SignInProviders.Twitter:
          await this.authService.twitterLoginWithRedirect();
          break;
        case SignInProviders.GitHub:
          await this.authService.gitHubLoginWithRedirect();
          break;
        case SignInProviders.PhoneNumber:
          this.showPhoneNumberForm();
          break;
      }
    } catch (e) {
      Sentry.captureException(e);
      this.logger.error(e);
      this.snackBar.open(`Could not log in due to ${e}`, null, {
        duration: 2000,
      });
    }
    this.isLoading = false;
  }

  async suuntoAppLogin() {
    this.isLoading = true;
    // Open the popup that will start the auth flow.
    const wnd = window.open('assets/authPopup.html?signInWithService=true', 'name', 'height=585,width=400');
    if (!wnd || wnd.closed || typeof wnd.closed === 'undefined') {
      this.snackBar.open(`Popup has been block by your browser settings. Please disable popup blocking for this site to connect with the Suunto app`, null, {
        duration: 5000,
      });
      Sentry.captureException(new Error(`Could not open popup for signing in with the Suunto app`));
    }
    wnd.onunload = () => this.isLoading = false;
  }

  private async redirectOrShowDataPrivacyDialog(loginServiceUser, serviceName?: string, serviceToken?: ServiceTokenInterface) {
    this.isLoading = true;
    try {
      const databaseUser = await this.userService.getUserByID(loginServiceUser.user.uid).pipe(take(1)).toPromise();
      if (databaseUser) {
        if (serviceName && serviceToken) {
          await this.userService.setSuuntoAppToken(databaseUser, serviceName, serviceToken)
        }
        this.afa.logEvent('login', {method: loginServiceUser.credential ? loginServiceUser.credential.signInMethod : 'Guest'});
        await this.router.navigate(['/dashboard']);
        this.snackBar.open(`Welcome back ${databaseUser.displayName || 'Guest'}`, null, {
          duration: 5000,
        });
        return;
      }
      this.showUserAgreementFormDialog(new User(loginServiceUser.user.uid, loginServiceUser.user.displayName, loginServiceUser.user.photoURL), loginServiceUser.credential ? loginServiceUser.credential.signInMethod : 'Anonymous', serviceName, serviceToken)
    } catch (e) {
      Sentry.captureException(e);
      this.isLoading = false;
    }
  }

  private showUserAgreementFormDialog(user: User, signInMethod: string, serviceName?: string, serviceToken?: ServiceTokenInterface) {
    const dialogRef = this.dialog.open(UserAgreementFormComponent, {
      minWidth: '80vw',
      disableClose: true,
      data: {
        user: user,
        signInMethod: signInMethod,
        serviceName: serviceName,
        serviceToken: serviceToken,
      },
    });

    dialogRef.afterClosed().subscribe(result => {
      this.isLoading = false;
    });
  }

  @HostListener('window:resize', ['$event'])
  getColumnsToDisplayDependingOnScreenSize(event?) {
    return window.innerWidth < 600 ? 1 : window.innerWidth < 900 ? 2 : 3;
  }

  private showPhoneNumberForm() {
    const dialogRef = this.dialog.open(PhoneFormComponent, {
      width: '86vw',
      maxWidth: '86vw',
      disableClose: false,
      data: {},
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result && result.user) {
        this.redirectOrShowDataPrivacyDialog(result.user)
      }
      this.isLoading = false;
    });
  }

  ngOnDestroy(): void {
    if (this.userSubscription) {
      this.userSubscription.unsubscribe();
    }
  }

}


export enum SignInProviders {
  Anonymous,
  Google,
  Facebook,
  Twitter,
  SuuntoApp,
  GitHub,
  PhoneNumber,
}
