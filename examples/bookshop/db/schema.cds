namespace sap.demo.bookshop;

using { Currency, managed, cuid } from '@sap/cds/common';

entity Books : managed {
  key ID       : UUID;
  title        : String(111) not null;
  descr        : String(1000);
  stock        : Integer;
  price        : Decimal(9,2);
  currency     : Currency;
  author       : Association to Authors;
  genre        : Association to Genres;
}

entity Authors : managed {
  key ID      : UUID;
  name        : String(111) not null;
  dateOfBirth : Date;
  books       : Association to many Books on books.author = $self;
}

entity Genres {
  key code : String(3);
  name     : String(50);
}
