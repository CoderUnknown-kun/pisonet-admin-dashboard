if (!firebase.apps.length) {

  const app = firebase.initializeApp({
  apiKey: "AIzaSyCjzXD3I5PM8kqssK2BEWExr74KeCn0qs4",
  authDomain: "mlsn-industries.firebaseapp.com",
  projectId: "mlsn-industries",
  storageBucket: "mlsn-industries.firebasestorage.app",
  messagingSenderId: "713174022336",
  appId: "1:713174022336:web:74b33ecda2f22403fbd525"
});

  const appCheck = firebase.appCheck(app);

  appCheck.activate(
    new firebase.appCheck.ReCaptchaV3Provider(
      "6Lc3vnwsAAAAABb6AZgwEjIoJro22WLUQopJPwYj"
    ),
    true
  );

  window.auth = app.auth();
  window.db   = app.firestore();

  console.log("✅ Firebase initialized with NEW App ID + App Check");
}