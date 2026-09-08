using { sap.demo.bookshop as bookshop } from '../db/schema';

service CatalogService @(path: '/browse') {

  @readonly entity Books as projection on bookshop.Books {
    *,
    author.name as authorName
  };

  @readonly entity Authors as projection on bookshop.Authors;

  @readonly entity Genres as projection on bookshop.Genres;

  action submitOrder(book: Books:ID, quantity: Integer) returns Decimal;
}
