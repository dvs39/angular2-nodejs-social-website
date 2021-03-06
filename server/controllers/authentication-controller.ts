const Users = require('../datasets/users');
const UsersConnected = require('../datasets/connected-users');
import {ipConnection} from '../utils/utils';
import * as mongoose from 'mongoose';
import * as bcrypt from 'bcryptjs';
const nev = require('email-verification')(mongoose);
import * as request from 'request';
import * as jwt from 'jsonwebtoken';

export class AuthentificationController {
  io;

  constructor(io) {
    this.io = io;
    /**
     * Think to see :
     * https://medium.com/@pandeysoni/nodemailer-service-in-node-js-using-smtp-and-xoauth2-7c638a39a37e
     * https://nodemailer.com/smtp/oauth2/
     * and update nodemailer
     */

    /**
     * Information to add if your are using the Verification Module
     */

    nev.configure({
      persistentUserModel: Users,
      expirationTime: 600, // 10 minutes
      verificationURL: process.env.URLVERIF,
      shouldSendConfirmation: false,
      transportOptions: {
        service: process.env.MAILVERIF,
        // auth: {
        //   type: 'OAuth2',
        //   user: process.env.MAILACCOUNT, // Your gmail address.
        //   clientSecret: process.env.CLIENTSECRET,
        //   accessToken: process.env.ACCESSTOKEN,
        //   refreshToken: process.env.REFRESHTOKEN,
        //   clientId: process.env.CLIENTID
        // },
        auth: {
          user: process.env.MAILACCOUNT,
          pass: process.env.MAILPASS
        }
      },

      hashingFunction: Users.hashingFunction,
      passwordFieldName: 'password',
    }, function (err, options) {
      if (err) {
        console.log(err);
        return;
      }
      console.log('configured: ' + (typeof options === 'object'));
    });
    nev.generateTempUserModel(Users, function (err, tempUserModel) {
      if (err) {
        console.log(err);
        return;
      } else {
        console.log('generated temp user model: ' + (typeof tempUserModel === 'function'));
      }

    });

  }

  /**
   * When user signup. Can desactivate or activate the module with process.env.EMAIL_VERIFICATION value
   * @param req
   * @param res
   * @param next
   */
  signup = (req, res) => {
    req.assert('email', 'Email is not valid').isEmail();
    req.assert('email', 'Email cannot be blank').notEmpty();
    req.assert('pass', 'Password must be at least 4 characters long').len(4);
    req.sanitize('email').normalizeEmail({remove_dots: false});
    const errors = req.validationErrors();
    if (errors) {
      return res.status(400).send(errors);
    }
    const email = req.body.email;
    const newUser = new Users({
      email: req.body.email,
      password: req.body.pass,
      username: req.body.username,
      role: 2
    });

    nev.createTempUser(newUser, function (err, existingPersistentUser, newTempUser) {
      if (err) {
        console.log(err);
        return res.status(404).send('ERROR: creating temp user FAILED');
      }
      // user already exists in persistent collection
      console.log('logAlors', err, existingPersistentUser, newTempUser);
      if (existingPersistentUser) {
        return res.json({
          msg: 'You have already signed up and confirmed your account. Did you forget your password?'
        });
      }
      // new user created
      if (newTempUser) {
        const URL = newTempUser[nev.options.URLFieldName];

        const confirmTempUser = () => {
          return nev.confirmTempUser(URL, function (error, user) {
            console.log(user);
            if (error) {
              console.log(error);
            }
            if (user) {
              res.json(user);
            } else {
              return res.status(404).send('ERROR: confirming temp user FAILED' + err);
            }
          });
        };

        if (JSON.parse(process.env.EMAIL_VERIFICATION)) {
          nev.sendVerificationEmail(email, URL, (err, info) => {
            if (err) {
              console.log(err);
              return res.status(404).send('ERROR: sending verification email FAILED');
            }
            res.json({
              msg: 'An email has been sent to you. Please check it to verify your account.',
              info: info
            });
          });
        } else {
          confirmTempUser();
        }

        // user already exists in temporary collection!
      } else {
        res.json({
          msg: 'You have already signed up. Please check your email to verify your account.'
        });
      }
    });
  }

  resendVerificationEmail = (req, res) => {
    // resend verification button was clicked
    nev.resendVerificationEmail(req.params.email, (err, userFound) => {
      if (err) {
        return res.status(404).send('ERROR: resending verification email FAILED');
      }
      if (userFound) {
        res.json({
          msg: 'An email has been sent to you, yet again. Please check it to verify your account.'
        });
      } else {
        res.json({
          msg: 'Your verification code has expired. Please sign up again.'
        });
      }
    });
  }

  /**
   * the loging Method
   * @param req
   * @param res
   */
  login = (req, res) => {
    console.log(this);
    console.log('req.body', req.body);
    req.assert('email', 'Email cannot be blank and must be a correct email').notEmpty().isEmail();
    req.assert('password', 'Password cannot be blank').notEmpty();
    req.sanitize('email').normalizeEmail({remove_dots: false});
    const errors = req.validationErrors();
    if (errors) {
      return res.status(400).send(errors);
    }
    Users.find({email: req.body.email}, (err, results) => {
      if (err) {
        console.log(err);
      } else {
        if (results && results.length === 1) {
          const userData = results[0];
          bcrypt.compare(req.body.password, results[0].password, (err, ok) => {
            if (ok) {
              delete userData.password;
              UsersConnected.findOne({userId: userData._id.toString()}, (err, userAlreadyConnected) => {
                if (userAlreadyConnected) {
                  userAlreadyConnected.location.push({socketId: req.body.socketId, IP: ipConnection(req)});
                  userAlreadyConnected.save(() => {
                    this.locationSearch(userAlreadyConnected, req.body.socketId, userData);
                  });
                } else {
                  const newUserConnected = new UsersConnected({
                    userId: userData._id,
                    location: [{socketId: req.body.socketId, IP: ipConnection(req)}]
                  });
                  newUserConnected.save((err, savedUser) => {
                    this.locationSearch(savedUser, req.body.socketId, userData);
                  });
                }
                const token = jwt.sign({
                  user: userData
                }, process.env.SECRET_TOKEN, {expiresIn: '5h'});
                res.status(200).json({token});
              });

            } else {
              return res.status(401).send({msg: 'Invalid email or password'});
            }
          });
          this.io.sockets.emit('userConnected', results[0]._id);
        } else {
          return res.status(401).send({
            msg: 'The email address ' + req.body.email + ' is not associated with any account. ' +
            'Double-check your email address and try again.'
          });
        }
      }
    });
  }


  private locationSearch(savedUser, socketId, userData) {
    const idOfLocation = savedUser.location.indexOf(savedUser.location.find(elem => {
      return elem.socketId === socketId;
    }));

    if (userData && userData._doc && userData._doc.password
    ) {
      delete userData._doc.password;
      userData._doc.idOfLocation = savedUser.location[idOfLocation]['_id'];
    } else {
      userData.idOfLocation = savedUser.location[idOfLocation]['_id'];
    }
  }

  /**
   * Valid the email of user after clicking in the mail link
   * @param req
   * @param {string} req.body.url -token to ensure that you could sign in
   * @param res
   */
  emailVerif = (req, res) => {
    console.log(req.body);
    const url = req.body.url;
    console.log(url);
    nev.confirmTempUser(url, function (err, user) {
      console.log(user);
      if (err) {

      }
      if (user) {
        nev.sendConfirmationEmail(user['email'], (data) => {
          console.log(data);
          res.json(data);
        });

      } else {
        return res.status(404).send('ERROR: confirming temp user FAILED' + err);
      }
    });
  }


  /**
   * Valid Captcha of the Google Recaptcha
   * @param {Express.Appliication} req
   * @params {string} req.params.token -token to valid captcha
   * @param res
   */
  validCaptcha = (req, res) => {
    const token = req.params.token;
    const verificationUrl = 'https://www.google.com/recaptcha/api/siteverify?secret=' + process.env.SECRET_KEYCAPTCHA + '&response=' + token + '&remoteip=' + req.connection.remoteAddress;
    request(verificationUrl, (error, response, body) => {
      body = JSON.parse(body);
      // Success will be true or false depending upon captcha validation.
      if (body.success !== undefined && !body.success) {
        return res.json({'responseCode': 1, 'responseDesc': 'Failed captcha verification'});
      }
      res.json({'responseCode': 0, 'responseDesc': 'Sucess'});
    });
  }
}
