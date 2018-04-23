"use strict";

/*
Server for 2FA. Does CRUD operations on Firebase RealTime Database related to 2 FA tokens
*/ 


// Setting up dependencies

const express = require("express");
var app = express();
const bodyParser = require("body-parser");
var speakeasy = require("speakeasy");
var QRCode = require("qrcode");
const path = require("path");
var http = require("http");
var firebase = require("firebase");
var admin = require("firebase-admin");
const nodemailer = require("nodemailer");
var serviceAccount = require("./serviceAccountKey.json");
const mailTransport = nodemailer.createTransport({
  service: "gmail",
// we set up here the email account

});

// Server Settings

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: true
}));

app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

// Firebase Admin Setting Up

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://visionbitwallet.firebaseio.com"
});
var database = admin.database();

// Firebase Realtime Functions

var setSecretKey = function (key, uid) {
    database.ref("user/" + uid + "/token").set(key);
};

var getSecretKey  = function (uid) {
    return database.ref("user/" + uid + "/token")
    .once("value")
    .then(function(snapshot) {
        console.log(snapshot.val());
        return snapshot.val();
    })
    .catch((error) => {
        return error;
    });
};

var updateSecretKey = function (uid, token) {
    console.log("60");
    token.secret = token.tempSecret;
    token.activated = true;
    setSecretKey(token, uid);
};

var deactivateSecretKey = function(uid) {
    var token = { enabled: false, activated: false};
    setSecretKey(token, uid);
}

// Sends the QR Code to the user email

// Currently uses my gmail account

var sendCodeToEmail = function(data_url, response) {
    console.log(response);
    const mailOptions = {
      from: "'Vision Wallet' <noreply@firebase.com>",
      to: response.email,
      subject: "Has activado la opción de 2FA",
      html: '<h3>Activación de 2FA</h3>' +
            '<p>Gracias por activar el segundo factor de autentificación en la aplicación Vision Wallet. <br>' + 
            'Es necesario que escanee el código QR a través de Google Autenticator o Authy.</p><br>' + 
            '<b>Codigo:</b> <img src="cid:qrcode"/>',
        attachments: [{
        filename: "image.png",
        path: data_url,
        cid: "qrcode" //same cid value as in the html img src
    }]
    };

    console.log(mailOptions.html);
  
    // Building Email message.
  
    return mailTransport.sendMail(mailOptions)
      .then(() => console.log("New email"))
      .catch((error) => console.error("There was an error while sending the email:", error));
}

// Verifies the user has activated 2FAU

var verifySecret = function(otp, uid) {
    return new Promise((resolve, reject) => {
    getSecretKey(uid)
        .then((token) => {
            if (token.activated) {
                reject("ERROR.2FA.user_is_verified");
            }
            var verified = speakeasy.totp.verify({
                secret: token.tempSecret, // Secret of the logged in user
                encoding: "base32",
                token: otp
            });
            if (verified) {
                console.log("107");
                console.log("USER Is VERIFIED");
                // we need to update the secret
                updateSecretKey(uid, token)
                resolve("SUCCESS");
            }
            else {
                console.log("NOT VALID OTP");
                reject("ERROR.2FA.invalid_otp");
            }
        })
        .catch((error) => {
            console.log("WHAT HAPPENED");
            console.log(error);
            reject(error);
        });
    });
};

// Verifies the OTP is valid, then gives permission to the user on the APP

var verifyOTP = function(uid, otp) {
    getSecretKey(uid)
    .then((user) => {
        var verified = speakeasy.totp.verify({
            secret: user.secret,
            encoding: "base32",
            token: otp,
            window: 2
        });
        if (verified){
            return "SUCCESS";
        }
        return "ERROR.2FA.invalid_otp";
    })
    .catch((error) => {
        return error;
    });
}

// Verifies the ID Token generated by Firebase Auth on the Console
var verifyUser = function(token) {
    return new Promise((resolve, reject) => {
    admin.auth()
        .verifyIdToken(token)
        .then((user) => {
            // If user email is verified we can activate
            // if (user.email_verified) {
                resolve(user);
            //} else {
            //    reject("NO_VERIFIED_EMAIL");
            //}

        })
        .catch((error) => {
            console.log("143");
            console.log(error);
            reject ("ERROR.2FA.invalid_id_token");
        })
    }) 
};

// Allows a user to setup 2FAU

app.post("/twofactor/setup/enable", function(req, res){
    // we validate the id token
    verifyUser(req.body.idToken)
    .then((user) => {
        const secret = speakeasy.generateSecret({length: 10});
        var url = speakeasy.otpauthURL({ secret: secret.ascii, label: 'Vision Wallet', algorithm: 'sha512' });
        QRCode.toDataURL(url, (err, data_url)=> {
            setSecretKey({
                tempSecret: secret.base32, 
                dataURL: data_url,
                otpURL: url, 
                activated: false,
                enabled: true,
            }, user.uid);
            sendCodeToEmail(data_url, user);
            return res.json({
                message: "VERIFY_OTP",
                tempSecret: secret.base32,
                dataURL: data_url,
                otpURL: secret.otpauth_url,
            });
        });
    })
    .catch((error) => {
        return res.status(400).send(error);
    });
});

// Disables 2FAU

app.post("/twofactor/setup/deactivate", function(req, res){
    verifyUser(req.body.idToken)
    .then((user) => {
        deactivateSecretKey(user.uid);
        var message = "DELETED_2FA"
        res.status("200").send(message);
    })
    .catch((error) => {
        console.log(error);
        res.status("400").send(error);
    });
});

// Verifies the 2FAU Activation

app.post("/twofactor/setup/verify", function(req, res){
    verifyUser(req.body.idToken)
    .then((user) => {
        verifySecret(req.body.otp, user.uid)
        .then((message) => {
            console.log(message);
            return res.status(200).sendStatus(message);
        })
        .catch((error) => {
            console.log(error);
            return res.status(400).send(error);
        });
    })
    .catch((error) => {
        console.log(error);
        return res.status(400).send(error);
    });
});

// Verifies an OTP

app.post("/twofactor/verify" , function(req, res){
    verifyUser(req.body.idToken)
    .then((user) => {
        verifyOTP(user.uid, req.body.otp)
        .then((response) => {
            console.log("207");
            return res.status(200).send(response);
        })
        .catch((error) => {
            console.log(error);
            return res.status(400).send(error);
        });
    })
    .catch((error) => {
        return res.status(400).send(error);
    });
});

// Server Startup
app.listen("3000", ()=>{
    console.log("App running on 3000");
});